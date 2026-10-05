'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

delete process.env.CATALOG_OBSERVABILITY_ENABLED;
const { createRateLimit, install } = require('./catalog-observability.cjs');

const lines = [];
class FakeClient {
    query(_query, callback) {
        callback?.(null, { rows: [] });
        return undefined;
    }
}
class FakePool {
    constructor() {
        this.totalCount = 2;
        this.idleCount = 1;
        this.waitingCount = 0;
    }

    connect(callback) {
        callback?.(null, new FakeClient(), () => {});
        return undefined;
    }
}
class FakeServer {
    emit(event, request, response) {
        if (event !== 'request') return false;
        const pool = new FakePool();
        pool.connect(() => {});
        new FakeClient().query('SELECT canary@example.test bearer canary-token', () => {});
        response.statusCode = 503;
        response.emit('finish');
        return true;
    }
}
class FakeResponse extends EventEmitter {
    setHeader(name, value) {
        this.headers ??= {};
        this.headers[name] = value;
    }
}

const fakeHttp = { Server: FakeServer };
const fakePg = { Client: FakeClient, Pool: FakePool };
assert.equal(
    install({ enabled: true, sqlEnabled: true, slowMs: 100, maxEventsPerMinute: 3, write: line => lines.push(line), http: fakeHttp, pg: fakePg }),
    true,
);

const response = new FakeResponse();
new FakeServer().emit(
    'request',
    {
        url: '/shop-api',
        headers: {
            'x-fabric-request-id': 'not-safe canary-token',
            'x-fabric-stage': 'metadata',
            'x-fabric-operation': 'GetProductBySlug',
            authorization: 'Bearer canary-token',
            cookie: 'email=canary@example.test',
        },
    },
    response,
);

assert.equal(lines.length, 1);
assert.match(lines[0], /^\[catalog-observability-vendure\] /);
assert.doesNotMatch(lines[0], /canary-token|canary@example\.test|SELECT|authorization|cookie/i);
const record = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
assert.equal(record.stage, 'metadata');
assert.equal(record.operation, 'GetProductBySlug');
assert.equal(record.statusCode, 503);
assert.equal(record.sqlCount, 1);
assert.equal(record.sqlInstrumentation, 'request');
assert.equal(record.poolAcquireCount, 1);
assert.match(record.requestID, /^[0-9a-f-]{36}$/i);
assert.equal(response.headers['x-fabric-request-id'], record.requestID);
assert.ok(Buffer.byteLength(lines[0]) < 1024);

let now = 0;
const allowed = createRateLimit(2, () => now);
assert.equal(allowed(), true);
assert.equal(allowed(), true);
assert.equal(allowed(), false);
now = 60_000;
assert.equal(allowed(), true);

console.log('catalog observability backend whitelist, SQL/pool aggregation, generated ID, and rate limit passed');

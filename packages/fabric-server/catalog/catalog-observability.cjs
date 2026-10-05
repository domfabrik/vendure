'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const http = require('node:http');

const STAGES = new Set(['product', 'metadata', 'header', 'recommendations']);
const OPERATIONS = new Set(['GetProductBySlug', 'GetAllCollections', 'SearchCollectionProducts']);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage();

function install(options = {}) {
    const enabled = options.enabled ?? process.env.CATALOG_OBSERVABILITY_ENABLED === 'true';
    if (!enabled || globalThis.__fabricCatalogObservabilityInstalled) return false;
    globalThis.__fabricCatalogObservabilityInstalled = true;
    const slowMs = boundedInteger(options.slowMs ?? Number(process.env.CATALOG_OBSERVABILITY_SLOW_MS), 100, 60000, 1000);
    const rateLimit = createRateLimit(
        boundedInteger(options.maxEventsPerMinute ?? Number(process.env.CATALOG_OBSERVABILITY_MAX_EVENTS_PER_MINUTE), 1, 600, 60),
        options.now,
    );
    const write = options.write ?? (line => console.warn(line));
    const sqlEnabled = options.sqlEnabled ?? process.env.CATALOG_SQL_OBSERVABILITY_ENABLED === 'true';
    const pg = sqlEnabled ? (options.pg ?? loadPg()) : null;

    if (pg) instrumentPg(pg);
    instrumentHttp(options.http ?? http, { slowMs, rateLimit, write, sqlEnabled: Boolean(pg) });
    return true;
}

function instrumentHttp(httpModule, options) {
    const originalEmit = httpModule.Server.prototype.emit;
    httpModule.Server.prototype.emit = function fabricCatalogEmit(event, request, response, ...rest) {
        if (event !== 'request' || !request || !response || !String(request.url ?? '').startsWith('/shop-api')) {
            return originalEmit.call(this, event, request, response, ...rest);
        }
        const stage = header(request, 'x-fabric-stage');
        const operation = header(request, 'x-fabric-operation');
        if (!STAGES.has(stage) || !OPERATIONS.has(operation)) {
            return originalEmit.call(this, event, request, response, ...rest);
        }
        const incomingID = header(request, 'x-fabric-request-id');
        const context = {
            requestID: REQUEST_ID.test(incomingID) ? incomingID : randomUUID(),
            stage,
            operation,
            sqlInstrumentation: options.sqlEnabled ? 'request' : 'disabled',
            startedAt: process.hrtime.bigint(),
            sqlCount: 0,
            sqlDurationMs: 0,
            sqlMaxMs: 0,
            sqlErrors: 0,
            poolAcquireCount: 0,
            poolWaitMs: 0,
            poolMaxWaitMs: 0,
            poolAcquireErrors: 0,
            pools: new Set(),
        };
        response.setHeader('x-fabric-request-id', context.requestID);
        response.once('finish', () => finishRequest(context, response.statusCode, options));
        const dispatch = () => originalEmit.call(this, event, request, response, ...rest);
        return options.sqlEnabled ? storage.run(context, dispatch) : dispatch();
    };
}

function instrumentPg(pg) {
    const originalQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = function fabricCatalogQuery(...args) {
        const context = storage.getStore();
        if (!context) return originalQuery.apply(this, args);
        const startedAt = process.hrtime.bigint();
        let finished = false;
        const finish = error => {
            if (finished) return;
            finished = true;
            const durationMs = elapsedMs(startedAt);
            context.sqlCount += 1;
            context.sqlDurationMs += durationMs;
            context.sqlMaxMs = Math.max(context.sqlMaxMs, durationMs);
            if (error) context.sqlErrors += 1;
        };
        const callbackIndex = args.findLastIndex(value => typeof value === 'function');
        if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = function wrappedQueryCallback(error, ...callbackArgs) {
                finish(error);
                return callback.call(this, error, ...callbackArgs);
            };
        }
        try {
            const result = originalQuery.apply(this, args);
            if (result && typeof result.then === 'function') result.then(() => finish(), finish);
            return result;
        } catch (error) {
            finish(error);
            throw error;
        }
    };

    const originalConnect = pg.Pool.prototype.connect;
    pg.Pool.prototype.connect = function fabricCatalogConnect(...args) {
        const context = storage.getStore();
        if (!context) return originalConnect.apply(this, args);
        context.pools.add(this);
        const startedAt = process.hrtime.bigint();
        let finished = false;
        const finish = error => {
            if (finished) return;
            finished = true;
            const waitMs = elapsedMs(startedAt);
            context.poolAcquireCount += 1;
            context.poolWaitMs += waitMs;
            context.poolMaxWaitMs = Math.max(context.poolMaxWaitMs, waitMs);
            if (error) context.poolAcquireErrors += 1;
        };
        const callbackIndex = args.findLastIndex(value => typeof value === 'function');
        if (callbackIndex >= 0) {
            const callback = args[callbackIndex];
            args[callbackIndex] = function wrappedConnectCallback(error, ...callbackArgs) {
                finish(error);
                return callback.call(this, error, ...callbackArgs);
            };
        }
        try {
            const result = originalConnect.apply(this, args);
            if (result && typeof result.then === 'function') result.then(() => finish(), finish);
            return result;
        } catch (error) {
            finish(error);
            throw error;
        }
    };
}

function finishRequest(context, statusCode, options) {
    const durationMs = elapsedMs(context.startedAt);
    if (statusCode < 500 && durationMs < options.slowMs) return;
    if (!options.rateLimit()) return;
    const pool = [...context.pools].reduce(
        (result, item) => ({
            total: result.total + finiteCount(item.totalCount),
            idle: result.idle + finiteCount(item.idleCount),
            waiting: result.waiting + finiteCount(item.waitingCount),
        }),
        { total: 0, idle: 0, waiting: 0 },
    );
    const record = {
        schemaVersion: 1,
        event: 'vendure-catalog-request',
        requestID: context.requestID,
        stage: context.stage,
        operation: context.operation,
        outcome: statusCode >= 500 ? 'failure' : 'slow',
        errorClass: statusCode >= 500 ? 'Http5xx' : 'None',
        statusCode: Math.max(0, Math.trunc(statusCode)),
        durationMs: round(durationMs),
        sqlInstrumentation: context.sqlInstrumentation,
        sqlCount: context.sqlCount,
        sqlDurationMs: round(context.sqlDurationMs),
        sqlMaxMs: round(context.sqlMaxMs),
        sqlErrors: context.sqlErrors,
        poolAcquireCount: context.poolAcquireCount,
        poolWaitMs: round(context.poolWaitMs),
        poolMaxWaitMs: round(context.poolMaxWaitMs),
        poolAcquireErrors: context.poolAcquireErrors,
        poolTotal: pool.total,
        poolIdle: pool.idle,
        poolWaiting: pool.waiting,
    };
    options.write(`[catalog-observability-vendure] ${JSON.stringify(record)}`);
}

function createRateLimit(maxEvents, now = Date.now) {
    let windowStartedAt = now();
    let emitted = 0;
    return () => {
        const current = now();
        if (current - windowStartedAt >= 60000) {
            windowStartedAt = current;
            emitted = 0;
        }
        if (emitted >= maxEvents) return false;
        emitted += 1;
        return true;
    };
}

function loadPg() {
    try {
        return require(require.resolve('pg', { paths: [process.cwd(), '/app/node_modules'] }));
    } catch {
        return null;
    }
}

function header(request, name) {
    const value = request.headers?.[name];
    return Array.isArray(value) ? value[0] ?? '' : String(value ?? '');
}

function elapsedMs(startedAt) {
    return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function finiteCount(value) {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function round(value) {
    return Math.round(value * 1000) / 1000;
}

function boundedInteger(value, minimum, maximum, fallback) {
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

if (process.env.CATALOG_OBSERVABILITY_ENABLED === 'true') install();

module.exports = { createRateLimit, finishRequest, install };

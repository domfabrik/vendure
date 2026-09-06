/** Run with ts-node --project tsconfig.docker-runtime.json; real loopback PostgreSQL is mandatory. */
/* eslint-disable no-console -- This standalone acceptance runner prints named evidence and process failures. */
import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';

import { createLeadSmtpSink } from './lead-smtp-test-sink';

const children: ChildProcess[] = [];
let commandId = 0;
const schema = `lead_test_${Date.now()}`;
const basePort = Number(process.env.LEAD_TEST_BASE_PORT ?? 31670);
const mutation = `mutation Submit($input: SubmitLeadOrderInput!) {
    submitLeadOrder(input: $input) { orderId code currencyCode totalWithTax
        lines { productVariantId quantity unitPriceWithTax linePriceWithTax } }
}`;
async function command(child: ChildProcess, action: string, data: any = {}): Promise<any> {
    const id = ++commandId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.off('message', listener);
            reject(new Error(`IPC timeout: ${action}`));
        }, 30000);
        const listener = (message: any) => {
            if (message.id !== id) return;
            clearTimeout(timer);
            child.off('message', listener);
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
        };
        child.on('message', listener);
        child.send({ id, action, ...data });
    });
}
async function start(index: number, seed: boolean) {
    const child = fork(path.join(__dirname, 'lead-test-server.ts'), [], {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        env: {
            ...process.env,
            TS_NODE_PROJECT: 'tsconfig.docker-runtime.json',
            DB_SCHEMA: schema,
            LEAD_TEST_WORKER: 'true',
            LEAD_TEST_SEED: String(seed),
            LEAD_TEST_PORT: String(basePort + index),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    // Output contains only synthetic fixtures; the worker removes every SMTP environment variable before bootstrap.
    child.stderr?.on('data', data => process.stderr.write(data));
    const ready: any = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Vendure bootstrap timeout')), 90000);
        child.on('message', (message: any) => {
            if (message.ready) {
                clearTimeout(timeout);
                resolve(message);
            }
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            reject(new Error(`Vendure worker exited ${String(code)}`));
        });
    });
    return { child, variantId: ready.variantId };
}
async function graphql(index: number, query: string, variables: any = {}, token?: string, channel?: string) {
    const response = await fetch(`http://127.0.0.1:${basePort + index}/shop-api`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(channel ? { 'vendure-token': channel } : {}),
        },
        body: JSON.stringify({ query, variables }),
    });
    return {
        ...((await response.json()) as any),
        token: response.headers.get('vendure-auth-token'),
        cookie: response.headers.get('set-cookie'),
    };
}
async function handshake(index = 0) {
    const result = await graphql(index, 'mutation { prepareLeadOrder { sessionCapability } }');
    assert(!result.errors, JSON.stringify(result.errors));
    assert(result.token);
    assert(result.cookie);
    return { token: result.token, capability: result.data.prepareLeadOrder.sessionCapability };
}
async function main() {
    assert.equal(process.env.DB_HOST, '127.0.0.1', 'Only owned loopback PostgreSQL may be used');
    assert(process.env.DB_NAME && process.env.DB_PORT && process.env.DB_USERNAME && process.env.DB_PASSWORD);
    const pg = new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    });
    await pg.connect();
    await pg.query(`CREATE SCHEMA "${schema}"`);
    await pg.end();
    const first = await start(0, true);
    let second = await start(1, false);
    const session = await handshake();
    const makeInput = (qty = 2) => ({
        sessionCapability: session.capability,
        submissionToken: randomUUID(),
        items: [{ productVariantId: first.variantId, quantity: qty }],
        contact: { fullName: 'Synthetic Customer', phone: '+70000000000' },
    });
    const submit = async (input: any, index = 0, token = session.token, channel?: string) =>
        graphql(index, mutation, { input }, token, channel);
    const firstInput = makeInput();
    // First anonymous mutation without a durably received handshake cannot create a lead.
    const noHandshake = await graphql(0, mutation, { input: firstInput });
    assert(noHandshake.errors);
    assert.equal((await command(first.child, 'snapshot')).leads.length, 0);
    const one = await submit(firstInput);
    assert(!one.errors, JSON.stringify(one.errors));
    const receipt = one.data.submitLeadOrder;
    assert.equal(receipt.lines[0].quantity, 2);
    assert.equal(receipt.totalWithTax, 246800);
    assert.deepEqual((await submit(firstInput, 1)).data.submitLeadOrder, receipt);
    assert.deepEqual(
        (
            await submit(
                {
                    ...firstInput,
                    submissionToken: firstInput.submissionToken.toUpperCase(),
                    contact: { fullName: '  Synthetic   Customer  ', phone: '+7 (000) 000-00-00' },
                },
                1,
            )
        ).data.submitLeadOrder,
        receipt,
    );
    let snapshot = await command(first.child, 'snapshot');
    assert.equal(snapshot.leads.length, 1);
    assert.equal(snapshot.orders[0].active, false);
    assert.equal(snapshot.orders[0].state, 'LeadSubmitted');
    assert.equal(snapshot.orders[0].payments.length, 0);
    assert(snapshot.sessions.every((s: any) => s.activeOrderId == null));
    assert.equal(snapshot.history.length, 0);
    console.log(
        'TC-B1/B2: inactive lead, detached session, backend totals, no payment, lost-response replay proven',
    );

    const concurrentInput = makeInput(3);
    const concurrent = await Promise.all(
        Array.from({ length: 20 }, (_, i) => submit(concurrentInput, i % 2)),
    );
    for (const result of concurrent) assert(!result.errors, JSON.stringify(result.errors));
    assert.equal(new Set(concurrent.map(r => r.data.submitLeadOrder.orderId)).size, 1);
    const different = await Promise.all(Array.from({ length: 4 }, (_, i) => submit(makeInput(i + 1), i % 2)));
    for (const result of different) assert(!result.errors, JSON.stringify(result.errors));
    assert.equal(new Set(different.map(r => r.data.submitLeadOrder.orderId)).size, 4);
    snapshot = await command(first.child, 'snapshot');
    assert.equal(snapshot.leads.length, 6);
    console.log(
        'TC-B3: two independent Vendure processes, PostgreSQL, 20 same-token requests and distinct-token serialization proven',
    );

    assert(
        (await submit({ ...firstInput, contact: { ...firstInput.contact, fullName: 'Changed Customer' } }))
            .errors,
    );
    const stranger = await handshake(1);
    assert((await submit(firstInput, 1, stranger.token)).errors);
    assert((await submit(firstInput, 1, session.token, 'lead-other')).errors);
    for (const invalid of [
        { ...makeInput(), items: [] },
        { ...makeInput(), items: Array(51).fill(firstInput.items[0]) },
        { ...makeInput(), contact: { fullName: 'A'.repeat(201), phone: '+70000000000' } },
        { ...makeInput(), items: [{ productVariantId: first.variantId, quantity: 0 }] },
    ])
        assert((await submit(invalid)).errors);
    assert.equal((await command(first.child, 'snapshot')).leads.length, 6);
    await command(first.child, 'parentEnabled', { variantId: first.variantId, enabled: false });
    assert((await submit(makeInput())).errors);
    await command(first.child, 'parentEnabled', { variantId: first.variantId, enabled: true });
    console.log(
        'TC-B4: mismatch, session/channel boundaries and invalid/oversized inputs have no order side effects',
    );

    for (const point of ['lines', 'contact', 'finalize']) {
        const before = await command(first.child, 'snapshot');
        const input = makeInput();
        await command(first.child, 'fault', { point });
        assert((await submit(input)).errors);
        const failed = await command(first.child, 'snapshot');
        assert.equal(failed.leads.length, before.leads.length);
        assert.equal(failed.orders.length, before.orders.length);
        assert.equal(failed.history.length, before.history.length);
        await command(first.child, 'fault', { point: null });
        assert(!(await submit(input)).errors);
    }
    console.log('TC-B5: injected line/contact/finalization faults fully roll back and retry succeeds');

    // Core cart integration: consume the exact cart, replace quantities, detach, then create a fresh ordinary cart.
    const cartSession = await handshake();
    const addQuery = `mutation($id: ID!, $q: Int!) { addItemToOrder(productVariantId: $id, quantity: $q) {
            ... on Order { id lines { quantity } } ... on ErrorResult { errorCode message }
        } }`;
    // Existing-cart rollback must restore removed line identities, not merely preserve order counts.
    for (const [index, point] of ['lines', 'contact', 'finalize'].entries()) {
        const rollbackSession = await handshake();
        const originalQuantity = 11 + index;
        const originalCart = await graphql(
            0,
            addQuery,
            { id: first.variantId, q: originalQuantity },
            rollbackSession.token,
        );
        assert(!originalCart.errors, JSON.stringify(originalCart.errors));
        const orderId = originalCart.data.addItemToOrder.id;
        assert(orderId);
        const contactResult = await graphql(
            0,
            `
                mutation ($name: String!, $phone: String!) {
                    setOrderCustomFields(
                        input: { customFields: { recipientFullName: $name, recipientPhoneNumber: $phone } }
                    ) {
                        ... on Order {
                            id
                        }
                        ... on ErrorResult {
                            errorCode
                            message
                        }
                    }
                }
            `,
            { name: `Original synthetic contact ${index}`, phone: `+7000000000${index}` },
            rollbackSession.token,
        );
        assert(!contactResult.errors, JSON.stringify(contactResult.errors));
        assert.equal(contactResult.data.setOrderCustomFields.id, orderId);
        const original = await command(first.child, 'snapshot');
        const originalOrder = original.orders.find((order: any) => String(order.id) === orderId);
        const attachedSession = original.sessions.find((item: any) => String(item.activeOrderId) === orderId);
        assert(attachedSession);
        assert.equal(originalOrder.active, true);
        assert.equal(originalOrder.state, 'AddingItems');
        assert.equal(originalOrder.lines[0].quantity, originalQuantity);
        const retryInput = { ...makeInput(2 + index), sessionCapability: rollbackSession.capability };
        await command(first.child, 'fault', { point });
        assert((await submit(retryInput, 0, rollbackSession.token)).errors);
        const rolledBack = await command(first.child, 'snapshot');
        assert.deepEqual(
            rolledBack.orders.find((order: any) => String(order.id) === orderId),
            originalOrder,
        );
        assert.deepEqual(
            rolledBack.sessions.find((item: any) => item.id === attachedSession.id),
            attachedSession,
        );
        assert.deepEqual(rolledBack.leads, original.leads);
        assert.deepEqual(rolledBack.history, original.history);
        assert.deepEqual(rolledBack.orderHistory, original.orderHistory);
        assert.equal(rolledBack.orders.length, original.orders.length);
        const restoredActive = await graphql(
            1,
            '{ activeOrder { id lines { id quantity } customFields { recipientFullName recipientPhoneNumber } } }',
            {},
            rollbackSession.token,
        );
        assert.equal(restoredActive.data.activeOrder.id, orderId);
        assert.equal(restoredActive.data.activeOrder.lines[0].quantity, originalQuantity);
        assert.equal(restoredActive.data.activeOrder.lines[0].id, String(originalOrder.lines[0].id));
        assert.equal(
            restoredActive.data.activeOrder.customFields.recipientFullName,
            `Original synthetic contact ${index}`,
        );
        await command(first.child, 'fault', { point: null });
        const completed = await submit(retryInput, 1, rollbackSession.token);
        assert(!completed.errors, JSON.stringify(completed.errors));
        assert.equal(completed.data.submitLeadOrder.orderId, orderId);
        assert.equal(completed.data.submitLeadOrder.lines[0].quantity, 2 + index);
        assert.deepEqual(
            (await submit(retryInput, 0, rollbackSession.token)).data.submitLeadOrder,
            completed.data.submitLeadOrder,
        );
        const finalized = await command(first.child, 'snapshot');
        assert.equal(finalized.leads.length, Number(original.leads.length) + 1);
        assert.equal(finalized.leads.filter((lead: any) => lead.orderId === orderId).length, 1);
        assert.equal(finalized.orders.find((order: any) => String(order.id) === orderId).active, false);
        assert.equal(
            finalized.orders.find((order: any) => String(order.id) === orderId).state,
            'LeadSubmitted',
        );
        assert.equal(
            finalized.sessions.find((item: any) => item.id === attachedSession.id).activeOrderId,
            null,
        );
        assert.equal(finalized.history.length, original.history.length);
    }
    console.log(
        'TC-B5 existing carts: all three faults restore exact line IDs/quantities/contact/state/session/history/outbox; ' +
            'same-token retry finalizes the same order exactly once',
    );
    const cart = await graphql(0, addQuery, { id: first.variantId, q: 8 }, cartSession.token);
    assert(!cart.errors, JSON.stringify(cart.errors));
    const cartInput = { ...makeInput(4), sessionCapability: cartSession.capability };
    const cartLead = await submit(cartInput, 1, cartSession.token);
    assert(!cartLead.errors, JSON.stringify(cartLead.errors));
    assert.equal(cartLead.data.submitLeadOrder.orderId, cart.data.addItemToOrder.id);
    assert.equal(cartLead.data.submitLeadOrder.lines[0].quantity, 4);
    const active = await graphql(0, '{ activeOrder { id } }', {}, cartSession.token);
    assert.equal(active.data.activeOrder, null);
    const newCart = await graphql(0, addQuery, { id: first.variantId, q: 1 }, cartSession.token);
    assert.notEqual(newCart.data.addItemToOrder.id, cartLead.data.submitLeadOrder.orderId);
    console.log(
        'TC-B1/B2 cart boundary: pre-existing cart finalized with exact quantities; stale other-instance session cache resolves empty; fresh cart has new ID',
    );

    // Authenticated fallback and channel separation, using synthetic account data only.
    const registration = await graphql(
        0,
        `
            mutation {
                registerCustomerAccount(
                    input: {
                        emailAddress: "lead-test@example.invalid"
                        password: "Synthetic-password-123"
                        firstName: "Synthetic"
                        lastName: "Account"
                    }
                ) {
                    ... on Success {
                        success
                    }
                    ... on ErrorResult {
                        errorCode
                    }
                }
            }
        `,
    );
    assert.equal(registration.data.registerCustomerAccount.success, true);
    const login = await graphql(
        0,
        `
            mutation {
                authenticate(
                    input: {
                        native: { username: "lead-test@example.invalid", password: "Synthetic-password-123" }
                    }
                ) {
                    ... on CurrentUser {
                        id
                    }
                    ... on ErrorResult {
                        errorCode
                    }
                }
            }
        `,
    );
    assert(login.token);
    assert(login.data.authenticate.id);
    const authPrepare = await graphql(
        0,
        'mutation { prepareLeadOrder { sessionCapability } }',
        {},
        login.token,
    );
    const authCart = await graphql(0, addQuery, { id: first.variantId, q: 7 }, login.token);
    const authLead = await submit(
        { ...makeInput(2), sessionCapability: authPrepare.data.prepareLeadOrder.sessionCapability },
        1,
        login.token,
    );
    assert(!authLead.errors, JSON.stringify(authLead.errors));
    assert.equal(authLead.data.submitLeadOrder.orderId, authCart.data.addItemToOrder.id);
    assert.equal((await graphql(0, '{ activeOrder { id } }', {}, login.token)).data.activeOrder, null);
    await command(first.child, 'shareVariant', { variantId: first.variantId });
    const otherCart = await graphql(0, addQuery, { id: first.variantId, q: 9 }, login.token, 'lead-other');
    assert(otherCart.data.addItemToOrder.id, JSON.stringify(otherCart.data));
    const ownLead = await submit(
        { ...makeInput(3), sessionCapability: authPrepare.data.prepareLeadOrder.sessionCapability },
        1,
        login.token,
    );
    assert(!ownLead.errors, JSON.stringify(ownLead.errors));
    assert.notEqual(ownLead.data.submitLeadOrder.orderId, otherCart.data.addItemToOrder.id);
    assert.equal(
        (await graphql(0, '{ activeOrder { id lines { quantity } } }', {}, login.token, 'lead-other')).data
            .activeOrder.lines[0].quantity,
        9,
    );
    const markerAttempt = await graphql(
        0,
        'mutation { setOrderCustomFields(input: { customFields: { leadOriginChannel: "1" } }) { ... on Order { id } } }',
        {},
        login.token,
    );
    assert(markerAttempt.errors);
    await command(first.child, 'legacyOrigin', { orderId: otherCart.data.addItemToOrder.id });
    const legacyAmbiguousLead = await submit(
        { ...makeInput(2), sessionCapability: authPrepare.data.prepareLeadOrder.sessionCapability },
        1,
        login.token,
    );
    assert(!legacyAmbiguousLead.errors, JSON.stringify(legacyAmbiguousLead.errors));
    assert.notEqual(legacyAmbiguousLead.data.submitLeadOrder.orderId, otherCart.data.addItemToOrder.id);
    assert.equal(
        (await graphql(0, '{ activeOrder { id lines { quantity } } }', {}, login.token, 'lead-other')).data
            .activeOrder.lines[0].quantity,
        9,
    );
    console.log(
        'TC-B4 authenticated boundary: own cart closes, fallback does not resurrect it, attached other-channel cart and quantities preserved',
    );

    // Race standard core mutations against dedicated finalization across instances.
    for (let attempt = 0; attempt < 4; attempt++) {
        const racing = await handshake();
        await graphql(0, addQuery, { id: first.variantId, q: 1 }, racing.token);
        const raceInput = { ...makeInput(5), sessionCapability: racing.capability };
        const results = await Promise.all([
            submit(raceInput, 1, racing.token),
            graphql(0, addQuery, { id: first.variantId, q: 1 }, racing.token),
        ]);
        assert(!results[0].errors, JSON.stringify(results[0].errors));
        const state = await command(first.child, 'snapshot');
        const leadOrder = state.orders.find(
            (order: any) => String(order.id) === results[0].data.submitLeadOrder.orderId,
        );
        assert.equal(leadOrder.lines[0].quantity, 5);
        assert.equal(leadOrder.active, false);
        assert.equal(leadOrder.state, 'LeadSubmitted');
        assert.deepEqual(
            (await submit(raceInput, 0, racing.token)).data.submitLeadOrder,
            results[0].data.submitLeadOrder,
        );
    }
    console.log(
        'TC-B3 standard cart mutation race: submitted quantities immutable in four real cross-instance races',
    );
    assert.equal(await command(first.child, 'staleContact', { orderId: receipt.orderId }), 'rejected');
    assert.deepEqual((await submit(firstInput)).data.submitLeadOrder, receipt);

    // Deterministic stale read: invalid quantities skip core line hooks but core still saves its loaded Order.
    const invalidRaceSession = await handshake();
    const invalidRaceCart = await graphql(
        0,
        addQuery,
        { id: first.variantId, q: 1 },
        invalidRaceSession.token,
    );
    await command(first.child, 'pauseOrderRead', { orderId: invalidRaceCart.data.addItemToOrder.id });
    const invalidCoreMutation = graphql(0, addQuery, { id: first.variantId, q: 0 }, invalidRaceSession.token);
    let paused = false;
    for (let attempt = 0; attempt < 100 && !paused; attempt++) {
        paused = await command(first.child, 'orderReadPaused');
        if (!paused) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(paused);
    const invalidRaceInput = { ...makeInput(6), sessionCapability: invalidRaceSession.capability };
    const invalidRaceLead = await submit(invalidRaceInput, 1, invalidRaceSession.token);
    assert(!invalidRaceLead.errors, JSON.stringify(invalidRaceLead.errors));
    await command(first.child, 'releaseOrderRead');
    assert((await invalidCoreMutation).errors);
    const frozen = (await command(first.child, 'snapshot')).orders.find(
        (order: any) => String(order.id) === invalidRaceLead.data.submitLeadOrder.orderId,
    );
    assert.equal(frozen.state, 'LeadSubmitted');
    assert.equal(frozen.active, false);
    assert.equal(frozen.lines[0].quantity, 6);
    assert.deepEqual(
        (await submit(invalidRaceInput, 0, invalidRaceSession.token)).data.submitLeadOrder,
        invalidRaceLead.data.submitLeadOrder,
    );
    console.log(
        'TC-B3 stale invalid-input path: deterministic paused core read cannot reactivate or modify submitted lead',
    );

    assert.equal(await command(first.child, 'deliver', { mode: 'sent' }), 1);
    assert.equal(await command(second.child, 'deliver', { mode: 'failed' }), 1);
    assert.equal(await command(first.child, 'deliver', { mode: 'ambiguous' }), 1);
    snapshot = await command(first.child, 'snapshot');
    assert.equal(snapshot.history.length, 3);
    assert.deepEqual(
        snapshot.leads
            .filter((l: any) => l.notificationState !== 'pending')
            .map((l: any) => l.notificationState)
            .sort(),
        ['ambiguous', 'failed', 'sent'],
    );
    assert(snapshot.history[0].data.body.includes('Synthetic sofa'));
    assert(snapshot.history[0].data.body.includes('https://fixture.invalid/products/synthetic-sofa'));
    const pending = snapshot.leads.find((l: any) => l.notificationState === 'pending');
    await command(first.child, 'stale', { submissionId: pending.id });
    snapshot = await command(first.child, 'snapshot');
    assert.equal(snapshot.leads.find((l: any) => l.id === pending.id).notificationState, 'ambiguous');
    assert.equal(snapshot.history.length, 4);
    assert.deepEqual((await submit(firstInput)).data.submitLeadOrder, receipt);
    assert.equal((await command(first.child, 'snapshot')).history.length, 4);
    console.log(
        'TC-B7: local sink success/rejection/lost-ack, stale claimed recovery, atomic history and replay no duplication proven; no SMTP used',
    );

    const smtp = await createLeadSmtpSink();
    const attemptedAddresses = {
        port: smtp.port,
        from: 'original-from@example.invalid',
        to: 'original-to@example.invalid',
        cc: 'original-cc@example.invalid',
    };
    try {
        const claims = await Promise.all([
            command(first.child, 'deliveryProbe', attemptedAddresses),
            command(second.child, 'deliveryProbe', attemptedAddresses),
        ]);
        for (const scans of claims) {
            assert.equal(scans.length, 1);
            assert.equal(scans[0].rowCount, 1);
            assert.equal(scans[0].limited, true);
        }
        assert.equal(smtp.messages.length, 2);
        const firstMessageId = smtp.messages[0].body.match(/Message-ID:\s*(<[^>]+>)/i)?.[1];
        const secondMessageId = smtp.messages[1].body.match(/Message-ID:\s*(<[^>]+>)/i)?.[1];
        assert(firstMessageId);
        assert(secondMessageId);
        assert.notEqual(firstMessageId, secondMessageId);
        const historyBeforeCrash = (await command(first.child, 'snapshot')).history.length;
        await command(second.child, 'deliveryProbe', { ...attemptedAddresses, failFinish: true });
        assert.equal(smtp.messages.length, 3);
        const beforeRecovery = await command(first.child, 'snapshot');
        assert.equal(beforeRecovery.history.length, historyBeforeCrash);
        const interrupted = beforeRecovery.leads.find((lead: any) => lead.notificationState === 'attempting');
        assert(interrupted);
        assert.deepEqual(interrupted.attemptedEnvelope, {
            from: attemptedAddresses.from,
            to: attemptedAddresses.to,
            cc: attemptedAddresses.cc,
            subject: `Новая заявка #${String(interrupted.receipt.code)}`,
            messageId: interrupted.attemptedEnvelope.messageId,
        });
        assert(smtp.messages[2].recipients.includes('<original-to@example.invalid>'));
        assert(smtp.messages[2].recipients.includes('<original-cc@example.invalid>'));
        assert(smtp.messages[2].body.includes(String(interrupted.attemptedEnvelope.messageId)));
        await command(second.child, 'close');
        second = await start(1, false);
        await command(second.child, 'recoverEnvelope', { submissionId: interrupted.id });
        await command(second.child, 'recoverEnvelope', { submissionId: interrupted.id });
        const afterRecovery = await command(first.child, 'snapshot');
        const histories = afterRecovery.history.filter(
            (entry: any) => entry.data.metadata.submissionId === String(interrupted.id),
        );
        assert.equal(histories.length, 1);
        assert.equal(histories[0].data.from, attemptedAddresses.from);
        assert.equal(histories[0].data.recipient, attemptedAddresses.to);
        assert.equal(histories[0].data.cc, attemptedAddresses.cc);
        assert.equal(histories[0].data.subject, interrupted.attemptedEnvelope.subject);
        assert.equal(histories[0].data.metadata.messageId, interrupted.attemptedEnvelope.messageId);
        assert.equal(histories[0].data.metadata.attemptedEnvelopeStatus, 'recorded');
        assert.equal(histories[0].data.metadata.deliveryState, 'ambiguous');
        assert.equal(smtp.messages.length, 3);
        const legacyAttempt = afterRecovery.leads.find((lead: any) => lead.notificationState === 'pending');
        await command(second.child, 'recoverEnvelope', { submissionId: legacyAttempt.id, legacy: true });
        const legacyHistory = (await command(first.child, 'snapshot')).history.find(
            (entry: any) => entry.data.metadata.submissionId === String(legacyAttempt.id),
        );
        assert.equal(legacyHistory.data.recipient, '[original envelope unavailable]');
        assert.equal(legacyHistory.data.from, '[original envelope unavailable]');
        assert.equal(legacyHistory.data.subject, '[original envelope unavailable]');
        assert.equal(legacyHistory.data.metadata.attemptedEnvelopeStatus, 'unavailable');
        assert(!JSON.stringify(legacyHistory.data).includes('replacement-'));
        assert.equal(smtp.messages.length, 3);
        console.log(
            'TC-B7 review regression: actual SQL LIMIT1/one-row claims progress in two processes; ' +
                'real loopback SMTP acceptance then crash/restart preserves original envelope despite config change; ' +
                'legacy unknown envelope explicit; no resend',
        );
    } finally {
        await smtp.close();
    }

    assert.equal(await command(first.child, 'migrationDown'), 'refused-nonempty');
    const schemaCheck = await command(first.child, 'schemaCheck');
    assert.equal(schemaCheck.duplicate, '23505');
    assert(
        schemaCheck.uniques.some(
            (columns: string[]) => columns.join(',') === 'channelId,sessionId,tokenHash',
        ),
    );
    assert.deepEqual((await command(first.child, 'snapshot')).sentinel, [{ value: 'preserved' }]);
    const leadCount = (await command(first.child, 'snapshot')).leads.length;
    await command(first.child, 'close');
    const restarted = await start(0, false);
    assert.deepEqual((await submit(firstInput)).data.submitLeadOrder, receipt);
    assert.equal((await command(restarted.child, 'snapshot')).leads.length, leadCount);
    console.log(
        `TC-B6: additive up/empty down, nonempty rollback refused, sentinel preserved, process restart durable receipt proven; fixture schema ${schema}`,
    );
    await command(restarted.child, 'close');
    await command(second.child, 'close');
}
void main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        for (const child of children) if (child.exitCode == null) child.kill();
    });

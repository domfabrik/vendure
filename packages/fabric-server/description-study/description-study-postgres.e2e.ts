/** Run with ts-node --project tsconfig.docker-runtime.json; real loopback PostgreSQL is mandatory. */
/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { ChildProcess, fork } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';

import {
    QA_BUNDLE,
    QA_EXPERIMENT,
    V2_QA_BUNDLE,
    V2_QA_EXPECTATIONS,
    V2_QA_EXPERIMENT,
} from './description-study-test-fixture';

const children: ChildProcess[] = [];
const schema = `description_study_test_${Date.now()}`;
const basePort = Number(process.env.DESCRIPTION_STUDY_TEST_BASE_PORT ?? 31770);
let commandId = 0;

const prepareMutation = `mutation Prepare($experimentKey: String!) {
    prepareDescriptionComparison(experimentKey: $experimentKey) {
        status ballotToken productId slug productName imageUrl sourceUrl sourceKind
        parsedCharacteristics { name value }
        leftText rightText completed total studySessionId
    }
}`;
const submitMutation = `mutation Submit($input: DescriptionComparisonVoteInput!) {
    submitDescriptionComparison(input: $input) { saved duplicate completed }
}`;
const statsQuery = `query Stats($experimentKey: String!) {
    descriptionExperimentStats(experimentKey: $experimentKey) {
        experimentKey totalCandidates assigned submitted participants oldWins newWins equal skipped
        leftWins rightWins newOnLeft newOnRight
        products { productId slug productName oldVersionId newVersionId oldHash newHash oldEmpty
            submitted oldWins newWins equal skipped }
    }
}`;
const responsesQuery = `query Responses($experimentKey: String!, $skip: Int!, $take: Int!) {
    descriptionExperimentResponses(experimentKey: $experimentKey, skip: $skip, take: $take) {
        totalItems items { responseId participantKey studySessionId productId slug productName oldVersionId newVersionId
            oldHash newHash leftVersion rightVersion choice selectedVersion leftComment rightComment
            oldComment newComment assignedAt votedAt }
    }
}`;

async function command(
    child: ChildProcess,
    action: string,
    args: Record<string, unknown> = {},
): Promise<any> {
    const id = ++commandId;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`IPC timeout: ${action}`)), 30000);
        const listener = (message: any) => {
            if (message.id !== id) return;
            clearTimeout(timeout);
            child.off('message', listener);
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
        };
        child.on('message', listener);
        child.send({ id, action, ...args });
    });
}

async function start(index: number, seed: boolean, publicUrl = 'https://test.domfabrik.ru') {
    const child = fork(path.join(__dirname, 'description-study-test-server.ts'), [], {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        env: {
            ...process.env,
            TS_NODE_PROJECT: 'tsconfig.docker-runtime.json',
            DB_SCHEMA: schema,
            DESCRIPTION_STUDY_TEST_WORKER: 'true',
            DESCRIPTION_STUDY_TEST_SEED: String(seed),
            DESCRIPTION_STUDY_TEST_PORT: String(basePort + index),
            DESCRIPTION_STUDY_TEST_PUBLIC_URL: publicUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', data => process.stderr.write(data));
    child.stderr?.on('data', data => process.stderr.write(data));
    const ready = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('Description study Vendure bootstrap timeout')),
            90000,
        );
        child.on('message', (message: any) => {
            if (!message.ready) return;
            clearTimeout(timeout);
            resolve(message);
        });
        child.once('exit', code => {
            clearTimeout(timeout);
            reject(new Error(`Description study worker exited ${String(code)}`));
        });
    });
    return { child, ready };
}

async function graphql(
    index: number,
    api: 'shop-api' | 'admin-api',
    query: string,
    variables: Record<string, unknown> = {},
    token?: string,
    extraHeaders: Record<string, string> = {},
) {
    const response = await fetch(`http://127.0.0.1:${basePort + index}/${api}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...extraHeaders,
        },
        body: JSON.stringify({ query, variables }),
    });
    return {
        ...((await response.json()) as any),
        token: response.headers.get('vendure-auth-token'),
        cookie: response.headers.get('set-cookie'),
    };
}

async function prepare(index = 0, token?: string, extraHeaders: Record<string, string> = {}) {
    return graphql(index, 'shop-api', prepareMutation, { experimentKey: QA_EXPERIMENT }, token, extraHeaders);
}

async function submit(index: number, token: string, input: Record<string, unknown>) {
    return graphql(index, 'shop-api', submitMutation, { input }, token);
}

async function adminLogin(index = 0) {
    const result = await graphql(
        index,
        'admin-api',
        `
            mutation Login($username: String!, $password: String!) {
                login(username: $username, password: $password, rememberMe: false) {
                    ... on CurrentUser {
                        id
                        identifier
                    }
                    ... on InvalidCredentialsError {
                        errorCode
                        message
                    }
                }
            }
        `,
        { username: 'superadmin', password: 'test' },
    );
    assert(!result.errors, JSON.stringify(result.errors));
    assert(result.token, 'Admin login did not return a bearer token');
    return result.token as string;
}

async function main() {
    assert.equal(process.env.DB_HOST, '127.0.0.1', 'Only owned loopback PostgreSQL may be used');
    assert(process.env.DB_NAME && process.env.DB_PORT && process.env.DB_USERNAME && process.env.DB_PASSWORD);
    const pgConfig = {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
    };
    const pg = new Client(pgConfig);
    await pg.connect();
    await pg.query(`CREATE SCHEMA "${schema}"`);
    await pg.end();

    let first = await start(0, true);
    const second = await start(1, false);
    assert.deepEqual(first.ready.bootstrapEvidence.first, { inserted: 4, existing: 0 });
    assert.deepEqual(first.ready.bootstrapEvidence.second, { inserted: 0, existing: 4 });
    assert.match(first.ready.bootstrapEvidence.hashTamper, /DESCRIPTION_STUDY_INVALID_BUNDLE/);
    assert.match(first.ready.bootstrapEvidence.changedDataset, /DESCRIPTION_STUDY_DATASET_CHANGED/);
    assert.match(first.ready.bootstrapEvidence.changedSource, /DESCRIPTION_STUDY_DATASET_CHANGED/);
    assert.match(first.ready.bootstrapEvidence.changedCharacteristics, /DESCRIPTION_STUDY_DATASET_CHANGED/);
    const schemaColumns = await command(first.child, 'schemaCheck');
    assert.deepEqual(
        schemaColumns.filter((column: any) =>
            ['sourceUrl', 'sourceKind', 'parsedCharacteristics'].includes(column.name),
        ),
        [
            { name: 'sourceUrl', type: 'text' },
            { name: 'sourceKind', type: 'character varying' },
            { name: 'parsedCharacteristics', type: 'jsonb' },
        ],
    );
    console.log(
        'TC-DS1: migration up twice, immutable bundle bootstrap, hash and dataset tamper refusal proven',
    );
    const v2Evidence = first.ready.bootstrapEvidence.v2;
    assert(v2Evidence.channelId);
    assert.deepEqual(v2Evidence.first, { inserted: V2_QA_BUNDLE.includedTotal, existing: 0 });
    assert.deepEqual(v2Evidence.second, { inserted: 0, existing: V2_QA_BUNDLE.includedTotal });
    assert.equal(v2Evidence.candidateCount, V2_QA_BUNDLE.includedTotal);
    assert.deepEqual(
        v2Evidence.candidateIds,
        V2_QA_BUNDLE.cases.map(item => item.sourceProductId),
    );
    for (const excludedId of v2Evidence.excludedIds) {
        assert(!v2Evidence.candidateIds.includes(excludedId));
    }
    assert.match(v2Evidence.changedDataset, /DESCRIPTION_STUDY_DATASET_CHANGED/);
    assert.deepEqual(v2Evidence.before, v2Evidence.after);
    assert.deepEqual(
        v2Evidence.before.map((candidate: any) => candidate.generationMetadata.cohortAccounting),
        V2_QA_BUNDLE.cases.map(item => item.generationMetadata.cohortAccounting),
    );
    assert.equal(
        Number(v2Evidence.before.length) + Number(v2Evidence.excludedIds.length),
        V2_QA_EXPECTATIONS.selectedTotal,
    );
    assert.equal(V2_QA_EXPERIMENT, V2_QA_BUNDLE.experimentKey);
    console.log(
        'TC-DS1v2: schema v2 inserted only eligible cases, excluded IDs stayed absent, repeat was idempotent, and recomputed exclusion accounting remained immutable',
    );

    const productionGate = await start(2, false, 'https://domfabrik.ru');
    const forbidden = await prepare(2, undefined, {
        origin: 'https://test.domfabrik.ru',
        host: 'test.domfabrik.ru',
    });
    assert(forbidden.errors);
    await command(productionGate.child, 'close');
    console.log('TC-DS1b: production runtime URL stayed closed despite test Host and Origin headers');

    const initial = await prepare(0, undefined, {
        origin: 'https://attacker.invalid',
        host: 'attacker.invalid',
    });
    assert(!initial.errors, JSON.stringify(initial.errors));
    assert(initial.token);
    assert(initial.cookie);
    const token = initial.token as string;
    const comparison = initial.data.prepareDescriptionComparison;
    assert.equal(comparison.status, 'READY');
    assert.equal(comparison.total, 4);
    assert.equal(comparison.completed, 0);
    assert(comparison.ballotToken && comparison.productId && comparison.slug && comparison.productName);
    const sourceCase = QA_BUNDLE.cases.find(item => item.sourceProductId === comparison.productId);
    assert(sourceCase);
    assert.equal(comparison.sourceUrl, sourceCase.sourceUrl);
    assert.equal(comparison.sourceKind, sourceCase.sourceKind);
    assert.deepEqual(comparison.parsedCharacteristics, sourceCase.parsedCharacteristics);
    assert.deepEqual(Object.keys(comparison).sort(), [
        'ballotToken',
        'completed',
        'imageUrl',
        'leftText',
        'parsedCharacteristics',
        'productId',
        'productName',
        'rightText',
        'slug',
        'sourceKind',
        'sourceUrl',
        'status',
        'studySessionId',
        'total',
    ]);
    const shopType = await graphql(
        0,
        'shop-api',
        `
            query {
                __type(name: "DescriptionComparison") {
                    fields {
                        name
                    }
                }
            }
        `,
        {},
        token,
    );
    assert.deepEqual(
        shopType.data.__type.fields.map((field: any) => field.name).sort(),
        Object.keys(comparison).sort(),
    );
    const leakAttempt = await graphql(
        0,
        'shop-api',
        `mutation { prepareDescriptionComparison(experimentKey: "${QA_EXPERIMENT}") { oldHash } }`,
        {},
        token,
    );
    assert(leakAttempt.errors);
    assert((await graphql(0, 'shop-api', statsQuery, { experimentKey: QA_EXPERIMENT }, token)).errors);
    const concurrentPrepare = await Promise.all(
        Array.from({ length: 20 }, (_, index) => prepare(index % 2, token)),
    );
    for (const response of concurrentPrepare) assert(!response.errors, JSON.stringify(response.errors));
    assert.equal(
        new Set(concurrentPrepare.map(response => response.data.prepareDescriptionComparison.ballotToken))
            .size,
        1,
    );
    assert(
        concurrentPrepare.every(
            response =>
                response.data.prepareDescriptionComparison.leftText === comparison.leftText &&
                response.data.prepareDescriptionComparison.rightText === comparison.rightText,
        ),
    );
    assert.equal(
        (await command(first.child, 'snapshot')).ballots.filter(
            (ballot: any) =>
                ballot.experimentKey === QA_EXPERIMENT && ballot.channelId !== 'qa-other-channel',
        ).length,
        1,
    );
    console.log(
        'TC-DS2: Owner issued anonymous cookie/token; request Host/Origin did not drive gate; 20 two-process prepares reused one blind assignment',
    );

    const firstVote = {
        ballotToken: comparison.ballotToken,
        choice: 'LEFT',
        leftComment: '<b>left exact</b>',
        rightComment: 'right exact',
    };
    const saved = await submit(0, token, firstVote);
    assert.deepEqual(saved.data.submitDescriptionComparison, { saved: true, duplicate: false, completed: 1 });
    const duplicate = await submit(1, token, firstVote);
    assert.deepEqual(duplicate.data.submitDescriptionComparison, {
        saved: true,
        duplicate: true,
        completed: 1,
    });
    assert((await submit(0, token, { ...firstVote, rightComment: 'changed' })).errors);
    assert((await submit(0, token, { ...firstVote, ballotToken: 'invalid' })).errors);
    assert((await submit(0, token, { ...firstVote, leftComment: 'x'.repeat(2001) })).errors);
    assert(
        (await graphql(0, 'shop-api', submitMutation, { input: { ...firstVote, choice: 'MIDDLE' } }, token))
            .errors,
    );
    const stranger = await prepare(1);
    assert(stranger.token);
    assert((await submit(1, stranger.token, firstVote)).errors);

    const secondComparison = (await prepare(1, token)).data.prepareDescriptionComparison;
    const secondVote = {
        ballotToken: secondComparison.ballotToken,
        choice: 'RIGHT',
        leftComment: 'second left',
        rightComment: 'second right',
    };
    const submitRace = await Promise.all(
        Array.from({ length: 12 }, (_, index) => submit(index % 2, token, secondVote)),
    );
    for (const response of submitRace) assert(!response.errors, JSON.stringify(response.errors));
    assert.equal(
        submitRace.filter(response => response.data.submitDescriptionComparison.duplicate === false).length,
        1,
    );
    assert.equal(
        submitRace.filter(response => response.data.submitDescriptionComparison.duplicate === true).length,
        11,
    );
    const conflictingComparison = (await prepare(0, token)).data.prepareDescriptionComparison;
    const conflictingVotes = [
        {
            ballotToken: conflictingComparison.ballotToken,
            choice: 'EQUAL',
            leftComment: 'race equal left',
            rightComment: 'race equal right',
        },
        {
            ballotToken: conflictingComparison.ballotToken,
            choice: 'SKIP',
            leftComment: 'race skip left',
            rightComment: 'race skip right',
        },
    ];
    const conflictingRace = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
            submit(index % 2, token, conflictingVotes[index % conflictingVotes.length]),
        ),
    );
    const conflictSuccesses = conflictingRace.filter(response => !response.errors);
    const conflictRejects = conflictingRace.filter(response => response.errors);
    assert.equal(conflictSuccesses.length, 10);
    assert.equal(conflictRejects.length, 10);
    assert.equal(
        conflictSuccesses.filter(response => response.data.submitDescriptionComparison.duplicate === false)
            .length,
        1,
    );
    const afterConflictRace = await command(first.child, 'snapshot');
    const storedConflict = afterConflictRace.ballots.find(
        (ballot: any) => ballot.ballotToken === conflictingComparison.ballotToken,
    );
    const winningVote = conflictingVotes.find(
        vote =>
            vote.choice === storedConflict.choice &&
            vote.leftComment === storedConflict.leftComment &&
            vote.rightComment === storedConflict.rightComment,
    );
    assert(winningVote);
    const losingVote = conflictingVotes.find(vote => vote !== winningVote);
    assert(losingVote);
    const winningReplay = await submit(0, token, winningVote);
    assert.equal(winningReplay.data.submitDescriptionComparison.duplicate, true);
    assert((await submit(1, token, losingVote)).errors);
    const afterLosingReplay = (await command(first.child, 'snapshot')).ballots.find(
        (ballot: any) => ballot.ballotToken === conflictingComparison.ballotToken,
    );
    assert.deepEqual(
        {
            choice: afterLosingReplay.choice,
            leftComment: afterLosingReplay.leftComment,
            rightComment: afterLosingReplay.rightComment,
        },
        {
            choice: storedConflict.choice,
            leftComment: storedConflict.leftComment,
            rightComment: storedConflict.rightComment,
        },
    );

    const finalComparison = (await prepare(0, token)).data.prepareDescriptionComparison;
    const finalChoice = winningVote.choice === 'EQUAL' ? 'SKIP' : 'EQUAL';
    const finalResult = await submit(1, token, {
        ballotToken: finalComparison.ballotToken,
        choice: finalChoice,
        leftComment: `${finalChoice} left`,
        rightComment: `${finalChoice} right`,
    });
    assert(!finalResult.errors, JSON.stringify(finalResult.errors));
    const complete = (await prepare(0, token)).data.prepareDescriptionComparison;
    assert.equal(complete.status, 'COMPLETE');
    assert.equal(complete.completed, 4);
    assert.equal(complete.total, 4);
    assert.equal(complete.sourceUrl, null);
    assert.equal(complete.sourceKind, null);
    assert.deepEqual(complete.parsedCharacteristics, []);
    const unavailable = (
        await graphql(0, 'shop-api', prepareMutation, { experimentKey: 'qa-unknown' }, token)
    ).data.prepareDescriptionComparison;
    assert.equal(unavailable.status, 'UNAVAILABLE');
    assert.equal(unavailable.sourceUrl, null);
    assert.equal(unavailable.sourceKind, null);
    assert.deepEqual(unavailable.parsedCharacteristics, []);
    console.log(
        'TC-DS3: atomic once-only submit, exact retry, two-process conflicting race with no overwrite, foreign/invalid rejection, UTF-16 limit, and completion proven',
    );

    const unauthorizedStats = await graphql(0, 'admin-api', statsQuery, { experimentKey: QA_EXPERIMENT });
    assert(unauthorizedStats.errors);
    const adminToken = await adminLogin();
    const statsResult = await graphql(
        0,
        'admin-api',
        statsQuery,
        { experimentKey: QA_EXPERIMENT },
        adminToken,
    );
    assert(!statsResult.errors, JSON.stringify(statsResult.errors));
    const stats = statsResult.data.descriptionExperimentStats;
    assert.equal(stats.totalCandidates, 4);
    assert.equal(stats.submitted, 4);
    assert.equal(stats.equal, 1);
    assert.equal(stats.skipped, 1);
    assert.equal(Number(stats.oldWins) + Number(stats.newWins), 2);
    assert.equal(stats.leftWins, 1);
    assert.equal(stats.rightWins, 1);
    assert.equal(Number(stats.newOnLeft) + Number(stats.newOnRight), Number(stats.assigned));
    assert.equal(stats.products.filter((product: any) => product.oldEmpty).length, 1);
    const responsesResult = await graphql(
        0,
        'admin-api',
        responsesQuery,
        { experimentKey: QA_EXPERIMENT, skip: 0, take: 100 },
        adminToken,
    );
    assert(!responsesResult.errors, JSON.stringify(responsesResult.errors));
    const responses = responsesResult.data.descriptionExperimentResponses;
    assert.equal(responses.totalItems, 4);
    const pageBoundary = await graphql(
        0,
        'admin-api',
        responsesQuery,
        { experimentKey: QA_EXPERIMENT, skip: 1, take: 200 },
        adminToken,
    );
    assert(!pageBoundary.errors, JSON.stringify(pageBoundary.errors));
    assert.equal(pageBoundary.data.descriptionExperimentResponses.totalItems, 4);
    assert.equal(pageBoundary.data.descriptionExperimentResponses.items.length, 3);
    for (const variables of [
        { experimentKey: QA_EXPERIMENT, skip: 0, take: 201 },
        { experimentKey: QA_EXPERIMENT, skip: 0, take: 0 },
        { experimentKey: QA_EXPERIMENT, skip: -1, take: 100 },
    ]) {
        assert((await graphql(0, 'admin-api', responsesQuery, variables, adminToken)).errors);
    }
    const firstResponse = responses.items.find((item: any) => item.responseId === '1') ?? responses.items[0];
    const expectedSelected =
        firstResponse.choice === 'LEFT' ? firstResponse.leftVersion : firstResponse.rightVersion;
    assert.equal(firstResponse.selectedVersion, expectedSelected);
    assert.equal(
        firstResponse.oldComment,
        firstResponse.leftVersion === 'OLD' ? firstResponse.leftComment : firstResponse.rightComment,
    );
    assert.equal(
        firstResponse.newComment,
        firstResponse.leftVersion === 'NEW' ? firstResponse.leftComment : firstResponse.rightComment,
    );
    assert(firstResponse.leftComment.includes('<b>'));
    assert(!JSON.stringify(responses).includes('vendure-auth-token'));
    console.log(
        'TC-DS4: SuperAdmin-only scoped stats/responses, exact Shop field boundary, ' +
            'pagination max/rejections, version/comment mappings, side counts and old-empty stratum proven',
    );

    const recoveryExperiment = 'description-study-session-recovery-qa';
    await command(first.child, 'sessionFixture', { experimentKey: recoveryExperiment });
    const sessionPrepare = (index: number, studySessionId?: string, auth?: string) =>
        graphql(
            index,
            'shop-api',
            `
                mutation ($experimentKey: String!, $studySessionId: String) {
                    prepareDescriptionComparison(
                        experimentKey: $experimentKey
                        studySessionId: $studySessionId
                    ) {
                        status
                        ballotToken
                        completed
                        total
                        studySessionId
                    }
                }
            `,
            { experimentKey: recoveryExperiment, studySessionId },
            auth,
        );
    const sessionId = 'a9dd61bd-741f-4cb3-89b8-19478bc67830';
    const legacy = await sessionPrepare(0);
    assert(!legacy.errors);
    assert.equal(legacy.data.prepareDescriptionComparison.studySessionId, null);
    const legacyToken = legacy.token as string;
    const oldBallot = legacy.data.prepareDescriptionComparison.ballotToken;
    const markerVote = {
        ballotToken: oldBallot,
        choice: 'EQUAL',
        leftComment: 'Проверка dot (ИИ)',
        rightComment: '',
    };
    assert(!(await submit(0, legacyToken, markerVote)).errors);
    const pendingLegacy = (await sessionPrepare(0, undefined, legacyToken)).data.prepareDescriptionComparison;
    const beforeRecovery = (await command(first.child, 'snapshot')).ballots.filter(
        (b: any) => b.experimentKey === recoveryExperiment,
    );
    const dryRun = await command(first.child, 'recoverDot', {
        experimentKey: recoveryExperiment,
        studySessionId: sessionId,
        dryRun: true,
    });
    assert.equal(dryRun.submitted, 1);
    assert.equal(dryRun.pending, 1);
    assert.equal(dryRun.backfilled, 2);
    assert.deepEqual(
        (await command(first.child, 'snapshot')).ballots.filter(
            (b: any) => b.experimentKey === recoveryExperiment,
        ),
        beforeRecovery,
    );
    const recovered = await command(first.child, 'recoverDot', {
        experimentKey: recoveryExperiment,
        studySessionId: sessionId,
        dryRun: false,
    });
    assert.equal(recovered.backfilled, 2);
    assert.equal(
        (
            await command(first.child, 'recoverDot', {
                experimentKey: recoveryExperiment,
                studySessionId: sessionId,
                dryRun: false,
            })
        ).backfilled,
        0,
    );
    const fresh = await sessionPrepare(1, sessionId.toUpperCase());
    assert(!fresh.errors, JSON.stringify(fresh.errors));
    assert.equal(fresh.data.prepareDescriptionComparison.studySessionId, sessionId);
    assert.equal(fresh.data.prepareDescriptionComparison.completed, 1);
    assert.equal(fresh.data.prepareDescriptionComparison.ballotToken, pendingLegacy.ballotToken);
    let freshToken = fresh.token as string;
    const multi = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
            sessionPrepare(i % 2, sessionId, i % 2 ? freshToken : legacyToken),
        ),
    );
    assert(
        multi.every(
            r => !r.errors && r.data.prepareDescriptionComparison.ballotToken === pendingLegacy.ballotToken,
        ),
    );
    await command(first.child, 'expireSession', { token: freshToken });
    await command(second.child, 'expireSession', { token: freshToken });
    const expiredBearerRecovery = await sessionPrepare(1, sessionId, freshToken);
    assert(!expiredBearerRecovery.errors, JSON.stringify(expiredBearerRecovery.errors));
    assert(
        expiredBearerRecovery.token && expiredBearerRecovery.token !== freshToken,
        'expired bearer must be replaced by a fresh anonymous Vendure session',
    );
    assert.equal(
        expiredBearerRecovery.data.prepareDescriptionComparison.ballotToken,
        pendingLegacy.ballotToken,
    );
    assert.equal(expiredBearerRecovery.data.prepareDescriptionComparison.completed, 1);
    assert.equal(expiredBearerRecovery.data.prepareDescriptionComparison.studySessionId, sessionId);
    freshToken = expiredBearerRecovery.token;
    const badVote = await submit(0, freshToken, { ballotToken: pendingLegacy.ballotToken, choice: 'SKIP' });
    assert(badVote.errors, 'fresh cookie without UUID must not access restored owner ballot');
    const wrongId = 'fda0c530-c936-4e21-9d1d-dd41e77188a0';
    assert(
        (
            await submit(0, freshToken, {
                ballotToken: pendingLegacy.ballotToken,
                choice: 'SKIP',
                studySessionId: wrongId,
            })
        ).errors,
    );
    assert((await sessionPrepare(0, 'invalid', freshToken)).errors);
    const afterRecovery = (await command(first.child, 'snapshot')).ballots.filter(
        (b: any) => b.experimentKey === recoveryExperiment,
    );
    assert.deepEqual(
        afterRecovery.map(({ studySessionId: _id, ...rest }: any) => rest),
        beforeRecovery.map(({ studySessionId: _id, ...rest }: any) => rest),
    );
    const nextVote = {
        ballotToken: pendingLegacy.ballotToken,
        studySessionId: sessionId,
        choice: 'RIGHT',
        leftComment: '',
        rightComment: 'ПРОВЕРКА DOT(ИИ)',
    };
    const votes = await Promise.all(
        Array.from({ length: 8 }, (_, i) => submit(i % 2, i % 2 ? freshToken : legacyToken, nextVote)),
    );
    assert(votes.every(r => !r.errors));
    assert.equal(votes.filter(r => !r.data.submitDescriptionComparison.duplicate).length, 1);
    assert.equal(
        (await sessionPrepare(0, wrongId, legacyToken)).data.prepareDescriptionComparison.studySessionId,
        sessionId,
        'mapped cookie returns canonical existing ID',
    );
    const adoptedExperiment = 'description-study-adoption-qa';
    await command(first.child, 'sessionFixture', { experimentKey: adoptedExperiment });
    const adoptionMutation = `mutation($experimentKey:String!, $studySessionId:String) {
        prepareDescriptionComparison(experimentKey:$experimentKey, studySessionId:$studySessionId) {
            ballotToken studySessionId completed
        }
    }`;
    const adoptionLegacy = await graphql(0, 'shop-api', adoptionMutation, {
        experimentKey: adoptedExperiment,
    });
    const adopted = await graphql(
        1,
        'shop-api',
        adoptionMutation,
        { experimentKey: adoptedExperiment, studySessionId: wrongId },
        adoptionLegacy.token,
    );
    assert(!adopted.errors);
    assert.equal(
        adopted.data.prepareDescriptionComparison.ballotToken,
        adoptionLegacy.data.prepareDescriptionComparison.ballotToken,
    );
    assert.equal(adopted.data.prepareDescriptionComparison.studySessionId, wrongId);
    const adoptedSnapshot = (await command(first.child, 'snapshot')).ballots.filter(
        (b: any) => b.experimentKey === adoptedExperiment,
    );
    assert.equal(adoptedSnapshot.length, 1);
    assert.equal(adoptedSnapshot[0].studySessionId, wrongId);
    await assert.rejects(
        command(first.child, 'recoverDot', {
            experimentKey: recoveryExperiment,
            studySessionId: wrongId,
            dryRun: false,
        }),
        /RECOVERY_CONFLICT/,
    );
    const unmarked = (await sessionPrepare(0, sessionId, legacyToken)).data.prepareDescriptionComparison;
    assert(
        !(
            await submit(0, legacyToken, {
                ballotToken: unmarked.ballotToken,
                studySessionId: sessionId,
                choice: 'SKIP',
            })
        ).errors,
    );
    await assert.rejects(
        command(first.child, 'recoverDot', { experimentKey: recoveryExperiment, studySessionId: sessionId }),
        /RECOVERY_UNMARKED_VOTES/,
    );
    const otherOwner = await sessionPrepare(0);
    assert(
        !(
            await submit(0, otherOwner.token, {
                ballotToken: otherOwner.data.prepareDescriptionComparison.ballotToken,
                choice: 'SKIP',
                rightComment: 'Проверка dot (ИИ)',
            })
        ).errors,
    );
    await assert.rejects(
        command(first.child, 'recoverDot', { experimentKey: recoveryExperiment, studySessionId: sessionId }),
        /RECOVERY_AMBIGUOUS/,
    );
    assert.equal(await command(first.child, 'participantMigrationDown'), 'refused-nonempty');
    const adminRecovered = await graphql(
        0,
        'admin-api',
        responsesQuery,
        { experimentKey: recoveryExperiment, skip: 0, take: 200 },
        adminToken,
    );
    assert(!adminRecovered.errors);
    assert(
        adminRecovered.data.descriptionExperimentResponses.items
            .filter((r: any) => r.participantKey === recovered.participantKey)
            .every((r: any) => r.studySessionId === sessionId),
    );
    assert(
        adminRecovered.data.descriptionExperimentResponses.items
            .filter((r: any) => r.participantKey !== recovered.participantKey)
            .every((r: any) => r.studySessionId === null),
    );
    const qaUnaffected = (await command(first.child, 'snapshot')).ballots.filter(
        (b: any) => b.experimentKey === QA_EXPERIMENT,
    );
    assert(
        qaUnaffected.every((b: any) => b.studySessionId === null),
        'recovery must leave other scopes untouched',
    );
    console.log(
        'TC-DS6: UUID recovery, scoped adoption/backfill, dry-run, unchanged vote payloads, concurrent browsers/votes and fail-closed recovery proven',
    );

    assert.equal(await command(first.child, 'migrationDown'), 'refused-nonempty');
    const beforeRestart = await command(first.child, 'snapshot');
    assert.deepEqual(beforeRestart.sentinel, [{ value: 'preserved' }]);
    await command(first.child, 'close');
    await command(second.child, 'close');
    first = await start(0, false);
    const afterRestart = await command(first.child, 'snapshot');
    const qaChannel = afterRestart.candidates.find(
        (candidate: any) =>
            candidate.experimentKey === QA_EXPERIMENT && candidate.channelId !== 'qa-other-channel',
    ).channelId;
    assert.equal(
        afterRestart.candidates.filter(
            (candidate: any) =>
                candidate.experimentKey === QA_EXPERIMENT && candidate.channelId === qaChannel,
        ).length,
        4,
    );
    for (const candidate of afterRestart.candidates.filter(
        (item: any) => item.experimentKey === QA_EXPERIMENT && item.channelId === qaChannel,
    )) {
        const expected = QA_BUNDLE.cases.find(item => item.sourceProductId === candidate.sourceProductId);
        assert(expected);
        assert.equal(candidate.sourceUrl, expected.sourceUrl);
        assert.equal(candidate.sourceKind, expected.sourceKind);
        assert.deepEqual(candidate.parsedCharacteristics, expected.parsedCharacteristics);
    }
    assert.equal(
        afterRestart.ballots.filter(
            (ballot: any) =>
                ballot.experimentKey === QA_EXPERIMENT &&
                ballot.channelId === qaChannel &&
                ballot.votedAt !== null,
        ).length,
        4,
    );
    const restartedAdmin = await adminLogin(0);
    const persisted = await graphql(
        0,
        'admin-api',
        responsesQuery,
        { experimentKey: QA_EXPERIMENT, skip: 0, take: 200 },
        restartedAdmin,
    );
    assert.equal(persisted.data.descriptionExperimentResponses.totalItems, 4);
    console.log(
        `TC-DS5: nonempty migration down refused and fresh Vendure process read durable candidates/comments/votes from ${schema}`,
    );
    await command(first.child, 'close');

    const cleanup = new Client(pgConfig);
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    await cleanup.end();
}

void main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        for (const child of children) if (child.exitCode == null) child.kill();
    });

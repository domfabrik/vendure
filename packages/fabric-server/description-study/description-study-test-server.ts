/** Isolated real-PostgreSQL worker. Never imported by the application. */
/* eslint-disable no-console -- Worker startup failures are test evidence. */
import {
    bootstrap,
    DefaultLogger,
    LanguageCode,
    LogLevel,
    NoopLogger,
    Populator,
    RequestContextService,
    Session,
    TransactionalConnection,
} from '@vendure/core';
import { randomUUID } from 'node:crypto';

import { AddDescriptionStudy1791230400000 } from '../../dev-server/migrations/1791230400000-add-description-study';

import { QA_BUNDLE, QA_EXPECTATIONS } from './description-study-test-fixture';
import { DescriptionStudyBallot, DescriptionStudyCandidate } from './description-study.entity';
import { DescriptionStudyPlugin } from './description-study.plugin';
import { DescriptionStudyService } from './description-study.service';

async function main() {
    const schema = process.env.DB_SCHEMA;
    if (
        process.env.DESCRIPTION_STUDY_TEST_WORKER !== 'true' ||
        !schema ||
        !/^description_study_test_[a-z0-9_]+$/.test(schema) ||
        process.env.DB_HOST !== '127.0.0.1'
    ) {
        throw new Error('Isolated description study worker configuration required');
    }
    process.env.VENDURE_PUBLIC_URL =
        process.env.DESCRIPTION_STUDY_TEST_PUBLIC_URL ?? 'https://test.domfabrik.ru';
    const seed = process.env.DESCRIPTION_STUDY_TEST_SEED === 'true';
    const app = await bootstrap({
        apiOptions: {
            hostname: '127.0.0.1',
            port: Number(process.env.DESCRIPTION_STUDY_TEST_PORT),
            adminApiPath: 'admin-api',
            shopApiPath: 'shop-api',
        },
        authOptions: {
            tokenMethod: ['bearer', 'cookie'],
            requireVerification: false,
            cookieOptions: { secret: 'isolated-description-study-cookie-secret' },
            superadminCredentials: { identifier: 'superadmin', password: 'test' },
        },
        defaultChannelToken: 'description-study-test-default',
        logger:
            process.env.DESCRIPTION_STUDY_TEST_DEBUG === 'true'
                ? new DefaultLogger({ level: LogLevel.Debug })
                : new NoopLogger(),
        dbConnectionOptions: {
            type: 'postgres',
            host: '127.0.0.1',
            port: Number(process.env.DB_PORT),
            database: process.env.DB_NAME,
            username: process.env.DB_USERNAME,
            password: process.env.DB_PASSWORD,
            schema,
            synchronize: seed,
            extra: { max: 12 },
        },
        paymentOptions: { paymentMethodHandlers: [] },
        plugins: [DescriptionStudyPlugin],
    });
    const connection = app.get(TransactionalConnection);
    const contexts = app.get(RequestContextService);
    const qualifiedSentinel = `"${schema}"."description_study_test_sentinel"`;
    let bootstrapEvidence: unknown;
    if (seed) {
        const runner = connection.rawConnection.createQueryRunner();
        await runner.startTransaction();
        try {
            await runner.query(`CREATE TABLE ${qualifiedSentinel} (value text NOT NULL)`);
            await runner.query(`INSERT INTO ${qualifiedSentinel} VALUES ('preserved')`);
            const migration = new AddDescriptionStudy1791230400000();
            await migration.down(runner);
            await migration.up(runner);
            await migration.up(runner);
            await runner.commitTransaction();
        } catch (error) {
            await runner.rollbackTransaction();
            throw error;
        } finally {
            await runner.release();
        }
        await app.get(Populator).populateInitialData({
            defaultLanguage: LanguageCode.en,
            defaultZone: 'Test',
            countries: [{ code: 'RU', name: 'Russia', zone: 'Test' }],
            taxRates: [{ name: 'Test tax', percentage: 0 }],
            shippingMethods: [],
            paymentMethods: [],
            collections: [],
        });
        const ctx = await contexts.create({ apiType: 'admin' });
        const service = app.get(DescriptionStudyService);
        const first = await service.syncBundle(ctx, QA_BUNDLE, QA_EXPECTATIONS);
        const second = await service.syncBundle(ctx, structuredClone(QA_BUNDLE), QA_EXPECTATIONS);
        let hashTamper = '';
        try {
            const invalid = structuredClone(QA_BUNDLE);
            invalid.cases[0].newHash = '0'.repeat(64);
            await service.syncBundle(ctx, invalid, QA_EXPECTATIONS);
        } catch (error) {
            hashTamper = error instanceof Error ? error.message : String(error);
        }
        let changedDataset = '';
        try {
            const changed = structuredClone(QA_BUNDLE);
            changed.cases[0].productName = 'Changed immutable title';
            await service.syncBundle(ctx, changed, QA_EXPECTATIONS);
        } catch (error) {
            changedDataset = error instanceof Error ? error.message : String(error);
        }
        let changedSource = '';
        try {
            const changed = structuredClone(QA_BUNDLE);
            changed.cases[1].sourceKind = 'VENDOR';
            changed.cases[1].sourceUrl = 'https://aridamebel.ru/catalog/qa-source-change';
            await service.syncBundle(ctx, changed, QA_EXPECTATIONS);
        } catch (error) {
            changedSource = error instanceof Error ? error.message : String(error);
        }
        let changedCharacteristics = '';
        try {
            const changed = structuredClone(QA_BUNDLE);
            changed.cases[1].parsedCharacteristics[0].value = 'Changed immutable characteristic';
            await service.syncBundle(ctx, changed, QA_EXPECTATIONS);
        } catch (error) {
            changedCharacteristics = error instanceof Error ? error.message : String(error);
        }
        const candidateRepository = connection.rawConnection.getRepository(DescriptionStudyCandidate);
        const ballotRepository = connection.rawConnection.getRepository(DescriptionStudyBallot);
        const addNoise = async (channelId: string, experimentKey: string, marker: string) => {
            const source = QA_BUNDLE.cases[1];
            const candidate = new DescriptionStudyCandidate();
            Object.assign(candidate, {
                ...source,
                channelId,
                experimentKey,
                sourceProductId: `${source.sourceProductId}-${marker}`,
                slug: `${source.slug}-${marker}`,
                ordinal: 999,
                sourceSnapshotSha256: QA_BUNDLE.sourceSnapshotSha256,
                schemaVersion: QA_BUNDLE.schemaVersion,
            });
            await candidateRepository.save(candidate);
            await ballotRepository.save(
                new DescriptionStudyBallot({
                    ballotToken: randomUUID(),
                    channelId,
                    experimentKey,
                    participantKey: marker.repeat(64).slice(0, 64),
                    candidateId: Number(candidate.id),
                    leftVersion: 'OLD',
                    choice: 'LEFT',
                    selectedVersion: 'OLD',
                    leftComment: `${marker} left`,
                    rightComment: `${marker} right`,
                    assignedAt: new Date(),
                    votedAt: new Date(),
                }),
            );
        };
        await addNoise('qa-other-channel', QA_BUNDLE.experimentKey, 'd');
        await addNoise(String(ctx.channelId), `${QA_BUNDLE.experimentKey}-other`, 'e');
        bootstrapEvidence = {
            first,
            second,
            hashTamper,
            changedDataset,
            changedSource,
            changedCharacteristics,
        };
    }

    const handle = async (message: any) => {
        try {
            let result: unknown;
            if (message.action === 'snapshot') {
                result = {
                    candidates: await connection.rawConnection
                        .getRepository(DescriptionStudyCandidate)
                        .find({ order: { ordinal: 'ASC' } }),
                    ballots: await connection.rawConnection
                        .getRepository(DescriptionStudyBallot)
                        .find({ order: { id: 'ASC' } }),
                    sessions: (await connection.rawConnection.getRepository(Session).find()).map(session => ({
                        id: String(session.id),
                        tokenHashOnly: session.token.length > 0,
                    })),
                    sentinel: await connection.rawConnection.query(`SELECT * FROM ${qualifiedSentinel}`),
                };
            } else if (message.action === 'migrationDown') {
                const runner = connection.rawConnection.createQueryRunner();
                await runner.startTransaction();
                try {
                    await new AddDescriptionStudy1791230400000().down(runner);
                    await runner.commitTransaction();
                    result = 'unexpected-success';
                } catch {
                    await runner.rollbackTransaction();
                    result = 'refused-nonempty';
                } finally {
                    await runner.release();
                }
            } else if (message.action === 'schemaCheck') {
                const runner = connection.rawConnection.createQueryRunner();
                try {
                    const table = await runner.getTable(`${schema}.description_study_candidate`);
                    result = table?.columns.map(column => ({ name: column.name, type: column.type }));
                } finally {
                    await runner.release();
                }
            } else if (message.action === 'close') {
                await app.close();
                process.send?.({ id: message.id, result: true });
                process.exit(0);
            } else {
                throw new Error('Unknown isolated description study action');
            }
            process.send?.({ id: message.id, result });
        } catch (error) {
            process.send?.({
                id: message.id,
                error: error instanceof Error ? error.message : 'Description study worker command failed',
            });
        }
    };
    process.on('message', message => void handle(message));
    process.send?.({ ready: true, bootstrapEvidence });
}

void main().catch(error => {
    console.error(error);
    process.exit(1);
});

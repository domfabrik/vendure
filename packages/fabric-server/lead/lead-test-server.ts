/** Isolated integration harness worker. Not imported by the application. */
import {
    bootstrap,
    CacheService,
    ChannelService,
    CurrencyCode,
    LanguageCode,
    NoopLogger,
    Order,
    OrderService,
    Populator,
    ProductService,
    ProductVariantService,
    RequestContextService,
    RoleService,
    Session,
    StockLocation,
    TaxCategory,
    TransactionalConnection,
    User,
} from '@vendure/core';

import { AddLeadSubmission1788648000000 } from '../../dev-server/migrations/1788648000000-add-lead-submission';
import { AddLeadAttemptedEnvelope1788651000000 } from '../../dev-server/migrations/1788651000000-add-lead-attempted-envelope';
import { OrderEmailHistoryPlugin } from '../email/email-history.plugin';

import { LeadNotificationService } from './lead-notification.service';
import { LeadOrderPlugin } from './lead-order.plugin';
import { LeadOrderService } from './lead-order.service';
import { LeadSubmission } from './lead-submission.entity';

async function main() {
    const databaseSchema = process.env.DB_SCHEMA;
    if (
        process.env.LEAD_TEST_WORKER !== 'true' ||
        !databaseSchema ||
        !/^lead_test_[a-z0-9_]+$/.test(databaseSchema) ||
        process.env.DB_HOST !== '127.0.0.1'
    )
        throw new Error('Isolated worker configuration required');
    // Tests can never pick up an operator SMTP configuration inherited from a shell.
    for (const key of Object.keys(process.env))
        if (key.startsWith('EMAIL_') || key.startsWith('ORDER_NOTIFICATION_')) delete process.env[key];
    process.env.STOREFRONT_ORIGIN = 'https://fixture.invalid';
    const app = await bootstrap({
        apiOptions: {
            hostname: '127.0.0.1',
            port: Number(process.env.LEAD_TEST_PORT),
            adminApiPath: 'admin-api',
            shopApiPath: 'shop-api',
        },
        authOptions: {
            tokenMethod: ['bearer', 'cookie'],
            requireVerification: false,
            cookieOptions: { secret: 'isolated-lead-test-cookie-secret' },
        },
        defaultChannelToken: 'lead-test-default',
        logger: new NoopLogger(),
        dbConnectionOptions: {
            type: 'postgres',
            host: '127.0.0.1',
            port: Number(process.env.DB_PORT),
            database: process.env.DB_NAME,
            username: process.env.DB_USERNAME,
            password: process.env.DB_PASSWORD,
            schema: databaseSchema,
            synchronize: process.env.LEAD_TEST_SEED === 'true',
            extra: { max: 12, options: `-c search_path=${databaseSchema}` },
        },
        paymentOptions: { paymentMethodHandlers: [] },
        customFields: {
            Order: [
                { name: 'recipientFullName', type: 'string', nullable: true },
                { name: 'recipientPhoneNumber', type: 'string', nullable: true },
            ],
        },
        plugins: [OrderEmailHistoryPlugin, LeadOrderPlugin],
    });
    const connection = app.get(TransactionalConnection);
    const contexts = app.get(RequestContextService);
    // Fault injection deliberately reaches non-public hooks only in this isolated worker.
    const notifications: any = app.get(LeadNotificationService);
    const leadService: any = app.get(LeadOrderService);
    const realTransport = notifications.transport.bind(notifications);
    let releaseOrderRead: (() => void) | undefined;
    let orderReadPaused = false;
    notifications.onModuleDestroy();
    let variantId = '';
    if (process.env.LEAD_TEST_SEED === 'true') {
        const runner = connection.rawConnection.createQueryRunner();
        await runner.startTransaction();
        try {
            await runner.query('CREATE TABLE lead_test_sentinel (value text NOT NULL)');
            await runner.query("INSERT INTO lead_test_sentinel VALUES ('preserved')");
            const migration = new AddLeadSubmission1788648000000();
            await migration.down(runner);
            await migration.up(runner);
            const envelopeMigration = new AddLeadAttemptedEnvelope1788651000000();
            await envelopeMigration.up(runner);
            await envelopeMigration.down(runner);
            await envelopeMigration.up(runner);
            await runner.commitTransaction();
        } catch (e) {
            await runner.rollbackTransaction();
            throw e;
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
        const product = await app.get(ProductService).create(ctx, {
            translations: [
                {
                    languageCode: LanguageCode.en,
                    name: 'Synthetic sofa',
                    slug: 'synthetic-sofa',
                    description: '',
                },
            ],
        });
        const tax = await connection.rawConnection
            .getRepository(TaxCategory)
            .findOneByOrFail({ name: 'Test tax' });
        const [variant] = await app.get(ProductVariantService).create(ctx, [
            {
                productId: product.id,
                sku: 'LEAD-SYNTHETIC',
                price: 123400,
                taxCategoryId: tax.id,
                stockOnHand: 100000,
                translations: [{ languageCode: LanguageCode.en, name: 'Synthetic sofa variant' }],
            },
        ]);
        variantId = String(variant.id);
        const channel = ctx.channel;
        await app.get(ChannelService).create(ctx, {
            code: 'lead-other',
            token: 'lead-other',
            defaultLanguageCode: LanguageCode.en,
            defaultCurrencyCode: CurrencyCode.USD,
            pricesIncludeTax: false,
            defaultTaxZoneId: channel.defaultTaxZone.id,
            defaultShippingZoneId: channel.defaultShippingZone.id,
        });
    }
    const handleMessage = async (message: any) => {
        try {
            let result: any;
            if (message.action === 'fault') {
                leadService.checkpoint = (point: string) => {
                    if (point === message.point) throw new Error('injected');
                    return Promise.resolve();
                };
                result = true;
            } else if (message.action === 'snapshot') {
                result = {
                    leads: await connection.rawConnection.getRepository(LeadSubmission).find(),
                    orders: (
                        await connection.rawConnection
                            .getRepository(Order)
                            .find({ relations: ['lines', 'payments'] })
                    ).map(order => ({
                        id: order.id,
                        state: order.state,
                        active: order.active,
                        customFields: order.customFields,
                        lines: order.lines.map(line => ({ id: line.id, quantity: line.quantity })),
                        payments: order.payments.map(payment => ({ id: payment.id })),
                    })),
                    sessions: (await connection.rawConnection.getRepository(Session).find()).map(s => ({
                        id: s.id,
                        activeOrderId: s.activeOrderId,
                    })),
                    history: (
                        await connection.rawConnection.query(
                            `SELECT * FROM history_entry WHERE type = 'ORDER_EMAIL_SENT'`,
                        )
                    ).map((entry: any) => ({
                        ...entry,
                        data: typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data,
                    })),
                    orderHistory: await connection.rawConnection.query(
                        'SELECT * FROM history_entry ORDER BY id',
                    ),
                    sentinel: await connection.rawConnection.query('SELECT * FROM lead_test_sentinel'),
                };
            } else if (message.action === 'deliver') {
                const captured: any[] = [];
                notifications.transport = () => (email: any) => {
                    captured.push(email);
                    if (message.mode === 'failed')
                        throw Object.assign(new Error('local rejection'), { responseCode: 550 });
                    if (message.mode === 'ambiguous') throw new Error('local lost acknowledgment');
                    return Promise.resolve();
                };
                await notifications.tick();
                result = captured.length;
            } else if (message.action === 'deliveryProbe') {
                if (!Number.isInteger(message.port) || message.port < 1024 || message.port > 65535)
                    throw new Error('Invalid local SMTP port');
                for (const address of [message.from, message.to, message.cc]) {
                    if (typeof address !== 'string' || !/^[a-z-]+@example\.invalid$/.test(address))
                        throw new Error('Synthetic recipient required');
                }
                Object.assign(process.env, {
                    EMAIL_SMTP_HOST: '127.0.0.1',
                    EMAIL_SMTP_PORT: String(message.port),
                    EMAIL_SMTP_USER: 'synthetic',
                    EMAIL_SMTP_PASSWORD: 'synthetic',
                    EMAIL_SMTP_SECURE: 'false',
                    EMAIL_FROM_ADDRESS: message.from,
                    ORDER_NOTIFICATION_RECIPIENT: message.to,
                    ORDER_NOTIFICATION_CC_RECIPIENTS: message.cc,
                });
                notifications.transport = realTransport;
                const source = connection.rawConnection;
                const originalRunner = source.createQueryRunner.bind(source);
                const scans: Array<{ rowCount: number; limited: boolean }> = [];
                source.createQueryRunner = (...args: any[]) => {
                    const runner = originalRunner(...args);
                    const originalQuery: any = runner.query.bind(runner);
                    runner.query = async (sql: string, parameters?: any[], structured?: boolean) => {
                        const value = await originalQuery(sql, parameters, structured);
                        if (sql.includes('SKIP LOCKED'))
                            scans.push({
                                rowCount: Array.isArray(value) ? value.length : value.records.length,
                                limited: /LIMIT 1\b/.test(sql),
                            });
                        return value;
                    };
                    return runner;
                };
                const originalFinish = notifications.finish;
                if (message.failFinish)
                    notifications.finish = () => Promise.reject(new Error('Synthetic post-accept failure'));
                try {
                    await notifications.tick();
                } catch (error) {
                    if (!message.failFinish) throw error;
                } finally {
                    source.createQueryRunner = originalRunner;
                    notifications.finish = originalFinish;
                }
                result = scans;
            } else if (message.action === 'recoverEnvelope') {
                Object.assign(process.env, {
                    EMAIL_FROM_ADDRESS: 'replacement-from@example.invalid',
                    ORDER_NOTIFICATION_RECIPIENT: 'replacement-to@example.invalid',
                    ORDER_NOTIFICATION_CC_RECIPIENTS: 'replacement-cc@example.invalid',
                });
                const repo = connection.rawConnection.getRepository(LeadSubmission);
                if (message.legacy)
                    await repo.update(message.submissionId, {
                        notificationState: 'attempting',
                        attemptedAt: new Date(Date.now() - 700000),
                        attemptedEnvelope: null,
                    });
                else
                    await repo.update(
                        { id: message.submissionId, notificationState: 'attempting' },
                        {
                            attemptedAt: new Date(Date.now() - 700000),
                        },
                    );
                await notifications.reconcileStaleAttempts();
                result = true;
            } else if (message.action === 'stale') {
                await connection.rawConnection.getRepository(LeadSubmission).update(message.submissionId, {
                    notificationState: 'attempting',
                    attemptedAt: new Date(Date.now() - 700000),
                });
                await notifications.reconcileStaleAttempts();
                result = true;
            } else if (message.action === 'schemaCheck') {
                const runner = connection.rawConnection.createQueryRunner();
                const table = await runner.getTable(`${databaseSchema}.lead_submission`);
                const existing = await connection.rawConnection
                    .getRepository(LeadSubmission)
                    .findOneOrFail({ where: {} });
                let duplicate = '';
                try {
                    await connection.rawConnection
                        .getRepository(LeadSubmission)
                        .save(new LeadSubmission({ ...existing, id: undefined, orderId: 'unique-probe' }));
                } catch (error: any) {
                    duplicate = error.code;
                }
                await runner.release();
                result = { duplicate, uniques: table?.uniques.map(unique => unique.columnNames) };
            } else if (message.action === 'shareVariant') {
                const user = await connection.rawConnection.getRepository(User).findOneOrFail({
                    where: { identifier: 'superadmin' },
                    relations: ['roles', 'roles.channels'],
                });
                const ctx = await contexts.create({ apiType: 'admin', user });
                const other = await app.get(ChannelService).getChannelFromToken('lead-other');
                await app.get(RoleService).assignRoleToChannel(ctx, user.roles[0].id, other.id);
                const location = await connection.rawConnection
                    .getRepository(StockLocation)
                    .findOneOrFail({ where: {} });
                await app.get(ChannelService).assignToChannels(ctx, StockLocation, location.id, [other.id]);
                await app.get(CacheService).invalidateTags(['StockLocation']);
                await app.get(ProductVariantService).assignProductVariantsToChannel(ctx, {
                    productVariantIds: [message.variantId],
                    channelId: other.id,
                    priceFactor: 1,
                });
                result = true;
            } else if (message.action === 'parentEnabled') {
                const ctx = await contexts.create({ apiType: 'admin' });
                const variant = await app
                    .get(ProductVariantService)
                    .findOne(ctx, message.variantId, ['product']);
                if (!variant) throw new Error('Synthetic variant unavailable');
                await app
                    .get(ProductService)
                    .update(ctx, { id: variant.productId, enabled: message.enabled });
                result = true;
            } else if (message.action === 'legacyOrigin') {
                await connection.rawConnection
                    .getRepository(Order)
                    .update(message.orderId, { customFields: { leadOriginChannel: null } as any });
                result = true;
            } else if (message.action === 'staleContact') {
                const ctx = await contexts.create({ apiType: 'admin' });
                try {
                    await connection.withTransaction(ctx, tx =>
                        app.get(OrderService).updateCustomFields(tx, message.orderId, {
                            recipientFullName: 'Forbidden change',
                        }),
                    );
                    result = 'unexpected-success';
                } catch {
                    result = 'rejected';
                }
            } else if (message.action === 'pauseOrderRead') {
                const orders: any = app.get(OrderService);
                const original = orders.getOrderOrThrow.bind(orders);
                orderReadPaused = false;
                orders.getOrderOrThrow = async (...args: any[]) => {
                    const order = await original(...args);
                    if (String(order.id) === String(message.orderId)) {
                        orders.getOrderOrThrow = original;
                        orderReadPaused = true;
                        await new Promise<void>(resolve => {
                            releaseOrderRead = resolve;
                        });
                    }
                    return order;
                };
                result = true;
            } else if (message.action === 'orderReadPaused') {
                result = orderReadPaused;
            } else if (message.action === 'releaseOrderRead') {
                releaseOrderRead?.();
                result = true;
            } else if (message.action === 'migrationDown') {
                const runner = connection.rawConnection.createQueryRunner();
                await runner.startTransaction();
                try {
                    await new AddLeadSubmission1788648000000().down(runner);
                    await runner.commitTransaction();
                    result = 'unexpected-success';
                } catch {
                    await runner.rollbackTransaction();
                    result = 'refused-nonempty';
                } finally {
                    await runner.release();
                }
            } else if (message.action === 'close') {
                await app.close();
                process.send?.({ id: message.id, result: true });
                process.exit(0);
            } else throw new Error('Unknown isolated test action');
            process.send?.({ id: message.id, result });
        } catch (error) {
            process.send?.({
                id: message.id,
                error: error instanceof Error ? error.message : 'Test command failed',
            });
        }
    };
    process.on('message', (message: any) => {
        void handleMessage(message);
    });
    process.send?.({ ready: true, variantId });
}
void main().catch(error => {
    // eslint-disable-next-line no-console -- Standalone fixture startup failure must be visible to its parent test runner.
    console.error(error);
    process.exit(1);
});

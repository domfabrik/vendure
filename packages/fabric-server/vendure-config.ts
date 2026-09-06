import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import {
    DefaultJobQueuePlugin,
    DefaultLogger,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    dummyPaymentHandler,
    LogLevel,
    VendureConfig,
} from '@vendure/core';
import { EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import 'dotenv/config';
import path from 'path';

import { aridaCatalogCustomFields } from './catalog/custom-fields';
import { CatalogPricingPlugin } from './catalog/catalog-pricing.plugin';
import { OrderEmailHistoryPlugin } from './email/email-history.plugin';
import { createNewOrderNotificationHandler } from './email/new-order-notification-handler';
import { LeadOrderPlugin } from './lead/lead-order.plugin';

class ExactStockDisplayStrategy {
    getStockLevel(_ctx: unknown, _productVariant: unknown, saleableStockLevel: number): string {
        return String(saleableStockLevel);
    }
}

const storefrontOrigins = (process.env.STOREFRONT_ORIGIN ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

const logLevel = process.env.LOG_LEVEL === 'debug' ? LogLevel.Debug : LogLevel.Info;
const assetUploadDir = process.env.VENDURE_ASSET_UPLOAD_DIR ?? path.join(process.cwd(), 'var/assets');
const publicUrl = process.env.VENDURE_PUBLIC_URL?.trim().replace(/\/+$/, '');
const assetUrlPrefix = publicUrl ? `${publicUrl}/assets/` : undefined;
const dashboardAppDir = path.join(process.cwd(), 'packages/fabric-server/dashboard/dist');
const emailTemplateDir = path.join(process.cwd(), 'packages/fabric-server/email/templates');
const superadminCredentials = getSuperadminCredentials();
const migrationExtension = path.extname(__filename) === '.js' ? 'js' : 'ts';
const vendureRole = process.env.VENDURE_ROLE ?? 'server';
const dbPoolMax = parsePositiveInt(
    process.env.VENDURE_DB_POOL_MAX,
    vendureRole === 'worker' || vendureRole === 'bootstrap' ? 4 : 8,
);
const jobQueuePollInterval = parsePositiveInt(process.env.VENDURE_JOB_QUEUE_POLL_INTERVAL_MS, 1000);
const jobQueueConcurrency = parsePositiveInt(process.env.VENDURE_JOB_QUEUE_CONCURRENCY, 1);
const bufferSearchUpdates = process.env.VENDURE_SEARCH_BUFFER_UPDATES === 'true';

export const fabricServerConfig: VendureConfig = {
    apiOptions: {
        hostname: '0.0.0.0',
        port: Number(process.env.PORT ?? 3000),
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        cors: {
            origin: storefrontOrigins.length > 0 ? storefrontOrigins : true,
            credentials: true,
        },
        trustProxy: parseTrustProxy(process.env.VENDURE_TRUST_PROXY),
    },
    authOptions: {
        disableAuth: false,
        tokenMethod: ['bearer', 'cookie'] as const,
        requireVerification: false,
        cookieOptions: {
            secret: process.env.COOKIE_SECRET ?? 'replace-me',
            sameSite: 'lax',
            secure: process.env.COOKIE_SECURE === 'true',
        },
        ...(superadminCredentials ? { superadminCredentials } : {}),
    },
    dbConnectionOptions: {
        type: 'postgres',
        host: process.env.DB_HOST ?? 'postgres',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'vendure',
        password: process.env.DB_PASSWORD ?? 'vendure',
        database: process.env.DB_NAME ?? 'vendure',
        schema: process.env.DB_SCHEMA ?? 'public',
        synchronize: process.env.VENDURE_DB_SYNCHRONIZE === 'true',
        extra: {
            max: dbPoolMax,
            connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 30000,
            application_name: `fabric-${vendureRole}`,
        },
        migrations: [path.join(__dirname, `../dev-server/migrations/*.${migrationExtension}`)],
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    catalogOptions: {
        stockDisplayStrategy: new ExactStockDisplayStrategy(),
    },
    customFields: aridaCatalogCustomFields,
    logger: new DefaultLogger({ level: logLevel }),
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../core/mock-data/assets'),
    },
    plugins: [
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir,
            assetUrlPrefix,
        }),
        DashboardPlugin.init({
            route: 'admin-dashboard',
            appDir: dashboardAppDir,
        }),
        DefaultSearchPlugin.init({
            bufferUpdates: bufferSearchUpdates,
            indexStockStatus: false,
        }),
        CatalogPricingPlugin,
        DefaultJobQueuePlugin.init({
            pollInterval: jobQueuePollInterval,
            concurrency: jobQueueConcurrency,
        }),
        OrderEmailHistoryPlugin,
        LeadOrderPlugin,
        ...getEmailPlugins(),
        ...(process.env.VENDURE_ENABLE_SCHEDULER === 'true' ? [DefaultSchedulerPlugin.init({})] : []),
    ],
};

function parseTrustProxy(value: string | undefined): boolean | number | string {
    if (value == null || value === '' || value === 'false' || value === '0') {
        return false;
    }
    if (value === 'true') {
        return true;
    }
    const parsedNumber = Number(value);
    return Number.isNaN(parsedNumber) ? value : parsedNumber;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (value == null || value.trim() === '') {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getSuperadminCredentials():
    | {
          identifier: string;
          password: string;
      }
    | undefined {
    const identifier = process.env.VENDURE_SUPERADMIN_USERNAME?.trim();
    const password = process.env.VENDURE_SUPERADMIN_PASSWORD?.trim();

    if (!identifier || !password) {
        return undefined;
    }

    return {
        identifier,
        password,
    };
}

function getEmailPlugins() {
    const primaryRecipient = process.env.ORDER_NOTIFICATION_RECIPIENT?.trim();
    if (!primaryRecipient) {
        return [];
    }
    const ccRecipients = splitList(process.env.ORDER_NOTIFICATION_CC_RECIPIENTS);

    const host = process.env.EMAIL_SMTP_HOST?.trim();
    const user = process.env.EMAIL_SMTP_USER?.trim();
    const password = process.env.EMAIL_SMTP_PASSWORD?.trim();
    const fromAddress = process.env.EMAIL_FROM_ADDRESS?.trim();

    if (!host || !user || !password || !fromAddress) {
        console.warn(
            '[email] ORDER_NOTIFICATION_RECIPIENT is set, but SMTP config is incomplete. Email notifications are disabled.',
        );
        return [];
    }

    const rawPort = process.env.EMAIL_SMTP_PORT?.trim();
    const port = rawPort ? Number(rawPort) : 465;
    if (Number.isNaN(port)) {
        console.warn('[email] EMAIL_SMTP_PORT is invalid. Email notifications are disabled.');
        return [];
    }

    return [
        EmailPlugin.init({
            handlers: [createNewOrderNotificationHandler(primaryRecipient, ccRecipients)],
            templateLoader: new FileBasedTemplateLoader(emailTemplateDir),
            transport: {
                type: 'smtp',
                host,
                port,
                secure: parseBooleanEnv(process.env.EMAIL_SMTP_SECURE, port === 465),
                auth: {
                    user,
                    pass: password,
                },
                logging: parseBooleanEnv(process.env.EMAIL_SMTP_LOGGING, false),
                debug: parseBooleanEnv(process.env.EMAIL_SMTP_DEBUG, false),
            },
            globalTemplateVars: {
                fromAddress,
            },
        }),
    ];
}

function splitList(value: string | undefined): string[] {
    return (value ?? '')
        .split(/[;,\n]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
    if (value == null || value.trim() === '') {
        return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
    }
    return defaultValue;
}

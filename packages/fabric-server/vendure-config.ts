import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import {
    DefaultJobQueuePlugin,
    DefaultLogger,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    dummyPaymentHandler,
    LogLevel,
    VendureConfig,
} from '@vendure/core';
import 'dotenv/config';
import path from 'path';

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
const superadminCredentials = getSuperadminCredentials();
const migrationExtension = path.extname(__filename) === '.js' ? 'js' : 'ts';

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
        migrations: [path.join(__dirname, `../dev-server/migrations/*.${migrationExtension}`)],
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    catalogOptions: {
        stockDisplayStrategy: new ExactStockDisplayStrategy(),
    },
    customFields: {},
    logger: new DefaultLogger({ level: logLevel }),
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../core/mock-data/assets'),
    },
    plugins: [
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir,
        }),
        DefaultSearchPlugin.init({
            bufferUpdates: false,
            indexStockStatus: false,
        }),
        DefaultJobQueuePlugin.init({}),
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

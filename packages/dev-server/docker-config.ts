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

export const dockerConfig: VendureConfig = {
    apiOptions: {
        hostname: '0.0.0.0',
        port: Number(process.env.PORT ?? 3000),
        adminApiPath: 'admin-api',
        shopApiPath: 'shop-api',
        cors: {
            origin: storefrontOrigins.length > 0 ? storefrontOrigins : true,
            credentials: true,
        },
    },
    authOptions: {
        disableAuth: false,
        tokenMethod: ['bearer', 'cookie'],
        requireVerification: false,
        cookieOptions: {
            secret: process.env.COOKIE_SECRET ?? 'replace-me',
            sameSite: 'lax',
            secure: process.env.COOKIE_SECURE === 'true',
        },
    },
    dbConnectionOptions: {
        type: 'postgres',
        host: process.env.DB_HOST ?? 'postgres',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'vendure',
        password: process.env.DB_PASSWORD ?? 'vendure',
        database: process.env.DB_NAME ?? 'vendure',
        schema: process.env.DB_SCHEMA ?? 'public',
        synchronize: true,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    catalogOptions: {
        stockDisplayStrategy: new ExactStockDisplayStrategy(),
    },
    customFields: {},
    logger: new DefaultLogger({
        level: process.env.LOG_LEVEL === 'debug' ? LogLevel.Debug : LogLevel.Info,
    }),
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../core/mock-data/assets'),
    },
    plugins: [
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, 'assets'),
        }),
        DefaultSearchPlugin.init({
            bufferUpdates: false,
            indexStockStatus: false,
        }),
        DefaultJobQueuePlugin.init({}),
        DefaultSchedulerPlugin.init({}),
    ],
};

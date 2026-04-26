import {
    bootstrap,
    defaultConfig,
    JobQueueService,
    mergeConfig,
    Product,
    runMigrations,
    TransactionalConnection,
} from '@vendure/core';
import { populate } from '@vendure/core/cli';
import path from 'path';

import { initialData } from '../core/mock-data/data-sources/initial-data';

import { fabricServerConfig } from './vendure-config';

const productsCsvPath = path.join(__dirname, '../core/mock-data/data-sources/products.csv');

async function main() {
    await runMigrations(fabricServerConfig);

    if (process.env.VENDURE_INITIALIZE_SAMPLE_DATA !== 'true') {
        return;
    }

    const app = await bootstrap(fabricServerConfig);
    const connection = app.get(TransactionalConnection);
    const productCount = await connection.rawConnection.getRepository(Product).count();

    if (productCount > 0) {
        await app.close();
        return;
    }

    await app.close();

    const populatedApp = await populate(
        () =>
            bootstrap(
                mergeConfig(
                    defaultConfig,
                    mergeConfig(fabricServerConfig, {
                        authOptions: {
                            tokenMethod: 'bearer',
                            requireVerification: false,
                        },
                        importExportOptions: {
                            importAssetsDir: path.join(__dirname, '../core/mock-data/assets'),
                        },
                    }),
                ),
            ).then(async instance => {
                await instance.get(JobQueueService).start();
                return instance;
            }),
        initialData,
        productsCsvPath,
    );

    await populatedApp.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

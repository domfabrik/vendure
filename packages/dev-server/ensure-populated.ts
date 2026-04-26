import {
    bootstrap,
    defaultConfig,
    JobQueueService,
    mergeConfig,
    Product,
    TransactionalConnection,
} from '@vendure/core';
import { populate } from '@vendure/core/cli';
import path from 'path';

import { initialData } from '../core/mock-data/data-sources/initial-data';

import { dockerConfig } from './docker-config';

const productsCsvPath = path.join(__dirname, '../core/mock-data/data-sources/products.csv');

async function main() {
    const app = await bootstrap(dockerConfig);
    await app.get(JobQueueService).start();

    const connection = app.get(TransactionalConnection);
    const productCount = await connection.rawConnection.getRepository(Product).count();

    if (productCount === 0) {
        await app.close();
        const populatedApp = await populate(
            () =>
                bootstrap(
                    mergeConfig(
                        defaultConfig,
                        mergeConfig(dockerConfig, {
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
        return;
    }

    await app.close();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

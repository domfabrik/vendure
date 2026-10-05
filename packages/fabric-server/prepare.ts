import {
    bootstrap,
    defaultConfig,
    JobQueueService,
    Logger,
    mergeConfig,
    Product,
    runMigrations,
    TransactionalConnection,
} from '@vendure/core';
import { populate } from '@vendure/core/cli';
import path from 'path';

import { initialData } from '../core/mock-data/data-sources/initial-data';

import { bootstrapCatalogStructure } from './catalog/bootstrap-catalog-structure';
import { synchronizeDescriptionStudy } from './description-study/synchronize-description-study';
import { fabricServerConfig } from './vendure-config';

const productsCsvPath = path.join(__dirname, '../core/mock-data/data-sources/products.csv');

async function main() {
    await runMigrations(fabricServerConfig);

    let shouldPopulateSampleData = false;
    const app = await bootstrap(fabricServerConfig);

    try {
        const summary = await bootstrapCatalogStructure(app);
        Logger.info(`[catalog-bootstrap] complete ${JSON.stringify(summary)}`, 'FabricPrepare');
        const descriptionStudy = await synchronizeDescriptionStudy(app);
        Logger.info(
            `[description-study-bootstrap] complete ${JSON.stringify(descriptionStudy)}`,
            'FabricPrepare',
        );

        if (process.env.VENDURE_INITIALIZE_SAMPLE_DATA !== 'true') {
            return;
        }

        const connection = app.get(TransactionalConnection);
        const productCount = await connection.rawConnection.getRepository(Product).count();

        if (productCount > 0) {
            return;
        }

        shouldPopulateSampleData = true;
    } finally {
        await app.close();
    }

    if (!shouldPopulateSampleData) {
        return;
    }

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
    Logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err), 'FabricPrepare');
    process.exit(1);
});

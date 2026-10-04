import {
    bootstrap,
    Channel,
    CurrencyCode,
    defaultConfig,
    JobQueueService,
    LanguageCode,
    mergeConfig,
    Product,
    ProductVariant,
    RequestContextService,
    runMigrations,
    SearchService,
    TransactionalConnection,
} from '@vendure/core';
import { importProductsFromCsv, populate, populateCollections, populateInitialData } from '@vendure/core/cli';
import path from 'path';

import { initialData } from '../core/mock-data/data-sources/initial-data';

import { bootstrapCatalogStructure } from './catalog/bootstrap-catalog-structure';
import { fabricServerConfig } from './vendure-config';

const defaultProductsCsvPath = path.join(__dirname, '../core/mock-data/data-sources/products.csv');

async function main() {
    const baselineProductsCsvPath = getBaselineProductsCsvPath();
    if (!baselineProductsCsvPath) {
        await runMigrations(fabricServerConfig);
    }

    let shouldPopulateSampleData = false;
    const app = await bootstrap(fabricServerConfig);

    try {
        const summary = await bootstrapCatalogStructure(app);
        console.log('[catalog-bootstrap] complete', JSON.stringify(summary));

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

    if (baselineProductsCsvPath) {
        await populateBaseline(baselineProductsCsvPath);
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
        defaultProductsCsvPath,
    );

    await populatedApp.close();
}

async function populateBaseline(productsCsvPath: string) {
    const app = await bootstrap(
        mergeConfig(
            defaultConfig,
            mergeConfig(fabricServerConfig, {
                authOptions: {
                    tokenMethod: 'bearer',
                    requireVerification: false,
                },
            }),
        ),
    );

    try {
        const jobQueueService = app.get(JobQueueService);
        const connection = app.get(TransactionalConnection);
        await jobQueueService.start();
        await populateInitialData(app, initialData);

        const channelRepository = connection.rawConnection.getRepository(Channel);
        const defaultChannel = await channelRepository.findOne({ where: { code: '__default_channel__' } });
        if (!defaultChannel) {
            throw new Error('Baseline seed could not find the default channel');
        }
        defaultChannel.availableLanguageCodes = [LanguageCode.en, LanguageCode.ru];
        defaultChannel.defaultCurrencyCode = CurrencyCode.RUB;
        defaultChannel.availableCurrencyCodes = [CurrencyCode.RUB];
        await channelRepository.save(defaultChannel, { reload: false });

        const result = await importProductsFromCsv(app, productsCsvPath, LanguageCode.en, defaultChannel);
        const importErrorCount = result.errors?.length ?? 0;
        if (importErrorCount > 0) {
            throw new Error(`Baseline fixture import failed with ${importErrorCount} errors`);
        }
        await connection.rawConnection.query(
            'UPDATE product_variant_price SET "currencyCode" = $1',
            [CurrencyCode.RUB],
        );

        const variantRepository = connection.rawConnection.getRepository(ProductVariant);
        const variants = await variantRepository.find({ order: { id: 'ASC' } });
        const activeVariantTarget = parseBaselinePositiveInt('FABRIC_SCM_ACTIVE_VARIANTS', 2478);
        const enabledVariantTarget = parseBaselinePositiveInt('FABRIC_SCM_ENABLED_VARIANTS', 2362);
        if (variants.length < activeVariantTarget || enabledVariantTarget > activeVariantTarget) {
            throw new Error(
                `Baseline fixture produced ${variants.length} variants; expected active/enabled targets ` +
                    `${activeVariantTarget}/${enabledVariantTarget}`,
            );
        }
        const variantsByProduct = new Map<string, ProductVariant[]>();
        for (const variant of variants) {
            const productId = String(variant.productId);
            const productVariants = variantsByProduct.get(productId);
            if (productVariants) {
                productVariants.push(variant);
            } else {
                variantsByProduct.set(productId, [variant]);
            }
        }
        const productGroups = [...variantsByProduct.entries()].sort(([left], [right]) => Number(left) - Number(right));
        const activeVariants: ProductVariant[] = [];
        const deletedVariants: ProductVariant[] = [];
        for (let productIndex = 0; productIndex < productGroups.length; productIndex += 1) {
            const productVariants = productGroups[productIndex][1];
            const activeForProduct = productIndex < 128 ? productVariants : productIndex < 256 ? [] : productVariants.slice(0, 1);
            const activeIds = new Set(activeForProduct.map(variant => String(variant.id)));
            activeVariants.push(...activeForProduct);
            for (const variant of productVariants) {
                if (!activeIds.has(String(variant.id))) {
                    variant.deletedAt = new Date('2000-01-01T00:00:00.000Z');
                    deletedVariants.push(variant);
                }
            }
        }
        if (activeVariants.length !== activeVariantTarget) {
            throw new Error(
                `Baseline fixture produced ${activeVariants.length} first variants; expected ${activeVariantTarget}`,
            );
        }
        for (let offset = enabledVariantTarget; offset < activeVariants.length; offset += 250) {
            const chunk = activeVariants.slice(offset, offset + 250);
            for (const variant of chunk) {
                variant.enabled = false;
            }
            await variantRepository.save(chunk, { reload: false });
        }
        if (deletedVariants.length !== variants.length - activeVariantTarget) {
            throw new Error(
                `Baseline fixture produced ${deletedVariants.length} deleted variants; expected ` +
                    `${variants.length - activeVariantTarget}`,
            );
        }
        for (let offset = 0; offset < deletedVariants.length; offset += 250) {
            await variantRepository.save(deletedVariants.slice(offset, offset + 250), { reload: false });
        }

        await populateCollections(app, initialData, defaultChannel);
        await connection.rawConnection.query(
            `
                INSERT INTO collection_product_variants_product_variant ("collectionId", "productVariantId")
                SELECT collection_translation."baseId", product_variant.id
                FROM collection_translation
                CROSS JOIN product_variant
                WHERE collection_translation.slug = $1
                  AND product_variant."deletedAt" IS NULL
                ON CONFLICT DO NOTHING
            `,
            ['furniture'],
        );
        const ctx = await app.get(RequestContextService).create({
            apiType: 'admin',
            languageCode: LanguageCode.en,
            channelOrToken: defaultChannel,
        });
        await app.get(SearchService).reindex(ctx);

        const counts = await connection.rawConnection.query(`
            SELECT
                (SELECT count(*)::int FROM product WHERE "deletedAt" IS NULL) AS products,
                (SELECT count(*)::int FROM product_variant) AS variants,
                (SELECT count(*)::int FROM product_variant WHERE "deletedAt" IS NULL) AS active_variants,
                (SELECT count(*)::int FROM product_variant WHERE "deletedAt" IS NULL AND enabled) AS enabled_variants,
                (SELECT count(*)::int FROM search_index_item) AS search_rows,
                (SELECT count(*)::int FROM (
                    SELECT product.id
                    FROM product
                    LEFT JOIN product_variant ON product_variant."productId" = product.id
                        AND product_variant."deletedAt" IS NULL
                    GROUP BY product.id
                    HAVING count(product_variant.id) = 0
                ) distribution) AS products_zero_variants,
                (SELECT count(*)::int FROM (
                    SELECT product.id
                    FROM product
                    LEFT JOIN product_variant ON product_variant."productId" = product.id
                        AND product_variant."deletedAt" IS NULL
                    GROUP BY product.id
                    HAVING count(product_variant.id) = 1
                ) distribution) AS products_one_variant,
                (SELECT count(*)::int FROM (
                    SELECT product.id
                    FROM product
                    LEFT JOIN product_variant ON product_variant."productId" = product.id
                        AND product_variant."deletedAt" IS NULL
                    GROUP BY product.id
                    HAVING count(product_variant.id) >= 2
                ) distribution) AS products_multiple_variants
        `);
        console.log('[fabric-scm-baseline] seed complete', JSON.stringify(counts[0]));
    } finally {
        await app.close();
    }
}

function getBaselineProductsCsvPath(): string | undefined {
    const rawPath = process.env.FABRIC_SCM_PRODUCTS_CSV?.trim();
    if (!rawPath) {
        return undefined;
    }
    if (process.env.FABRIC_SCM_ALLOW_LOCAL_SEED !== 'yes') {
        throw new Error('FABRIC_SCM_ALLOW_LOCAL_SEED=yes is required for the synthetic baseline seed');
    }
    if (process.env.DB_HOST !== 'postgres' || process.env.DB_NAME !== 'fabric_scm') {
        throw new Error('Synthetic baseline seed refuses any database except postgres/fabric_scm');
    }
    const resolved = path.resolve(rawPath);
    const allowedRoot = path.resolve(process.env.FABRIC_SCM_INPUT_ROOT ?? '/baseline-input');
    const relative = path.relative(allowedRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('FABRIC_SCM_PRODUCTS_CSV must stay inside FABRIC_SCM_INPUT_ROOT');
    }
    return resolved;
}

function parseBaselinePositiveInt(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

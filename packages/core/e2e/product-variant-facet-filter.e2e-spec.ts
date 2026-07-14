import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

import {
    CREATE_FACET,
    GET_PRODUCT_VARIANT_LIST,
    UPDATE_PRODUCT,
    UPDATE_PRODUCT_VARIANTS,
} from './graphql/shared-definitions';

describe('ProductVariant facet filtering', () => {
    const { server, adminClient } = createTestEnvironment(testConfig());

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
        adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('matches facets assigned to the product and the variant without duplicates', async () => {
        const { createFacet } = await adminClient.query(CREATE_FACET, {
            input: {
                isPrivate: false,
                code: 'variant-list-filter-test',
                translations: [{ languageCode: 'en', name: 'Variant list filter test' }],
                values: [
                    {
                        code: 'on-product',
                        translations: [{ languageCode: 'en', name: 'On product' }],
                    },
                    {
                        code: 'on-variant',
                        translations: [{ languageCode: 'en', name: 'On variant' }],
                    },
                    {
                        code: 'on-product-extra',
                        translations: [{ languageCode: 'en', name: 'On product extra' }],
                    },
                    {
                        code: 'not-assigned',
                        translations: [{ languageCode: 'en', name: 'Not assigned' }],
                    },
                ],
            },
        });

        const productFacetValue = createFacet.values[0];
        const variantFacetValue = createFacet.values[1];
        const extraProductFacetValue = createFacet.values[2];
        const notAssignedFacetValue = createFacet.values[3];

        await adminClient.query(UPDATE_PRODUCT, {
            input: {
                id: 'T_1',
                facetValueIds: [productFacetValue.id, extraProductFacetValue.id],
            },
        });
        await adminClient.query(UPDATE_PRODUCT_VARIANTS, {
            input: [
                { id: 'T_1', facetValueIds: [] },
                { id: 'T_2', facetValueIds: [variantFacetValue.id] },
            ],
        });

        const productFacetResult = await adminClient.query(GET_PRODUCT_VARIANT_LIST, {
            options: {
                filter: {
                    _and: [
                        {
                            facetValueId: {
                                in: [productFacetValue.id, extraProductFacetValue.id],
                            },
                        },
                    ],
                },
                filterOperator: 'OR',
                take: 20,
            },
        });
        expect(productFacetResult.productVariants.items.map((variant: any) => variant.id)).toContain('T_1');
        expect(productFacetResult.productVariants.totalItems).toBe(productFacetResult.productVariants.items.length);

        const variantFacetResult = await adminClient.query(GET_PRODUCT_VARIANT_LIST, {
            options: {
                filter: { _and: [{ facetValueId: { in: [variantFacetValue.id] } }] },
                filterOperator: 'OR',
                take: 20,
            },
        });
        expect(variantFacetResult.productVariants.items.map((variant: any) => variant.id)).toContain('T_2');
        expect(new Set(productFacetResult.productVariants.items.map((variant: any) => variant.id)).size).toBe(
            productFacetResult.productVariants.items.length,
        );

        const unassignedFacetResult = await adminClient.query(GET_PRODUCT_VARIANT_LIST, {
            options: {
                filter: { facetValueId: { eq: notAssignedFacetValue.id } },
                take: 20,
            },
        });
        expect(unassignedFacetResult.productVariants.items).toHaveLength(0);

        const mixedAndResult = await adminClient.query(GET_PRODUCT_VARIANT_LIST, {
            options: {
                filter: {
                    _and: [
                        { facetValueId: { eq: productFacetValue.id } },
                        { facetValueId: { eq: variantFacetValue.id } },
                    ],
                },
                take: 20,
            },
        });
        expect(mixedAndResult.productVariants.items.map((variant: any) => variant.id)).toContain('T_2');

        const noMixedMatchResult = await adminClient.query(GET_PRODUCT_VARIANT_LIST, {
            options: {
                filter: {
                    _and: [
                        { facetValueId: { eq: productFacetValue.id } },
                        { facetValueId: { eq: notAssignedFacetValue.id } },
                    ],
                },
                take: 20,
            },
        });
        expect(noMixedMatchResult.productVariants.items).toHaveLength(0);

        const excludedProductFacetResult = await adminClient.query(GET_PRODUCT_VARIANT_LIST, {
            options: {
                filter: { _and: [{ facetValueId: { notIn: [productFacetValue.id] } }] },
                filterOperator: 'OR',
                take: 20,
            },
        });
        expect(excludedProductFacetResult.productVariants.items.map((variant: any) => variant.id)).not.toContain(
            'T_1',
        );
    });
});

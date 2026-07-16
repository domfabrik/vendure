import { LogicalOperator } from '@vendure/common/lib/generated-types';
import { describe, expect, it } from 'vitest';

import { expandProductVariantFacetValueFilter } from './inherited-facet-value-filter';

describe('expandProductVariantFacetValueFilter', () => {
    it('matches a facet assigned to the variant or its product', () => {
        expect(
            expandProductVariantFacetValueFilter(
                {
                    _and: [{ facetValueId: { in: ['facet-1'] } }],
                },
                LogicalOperator.OR,
            ),
        ).toEqual({
            _and: [
                {
                    _or: [
                        { facetValueId: { in: ['facet-1'] } },
                        { productFacetValueId: { in: ['facet-1'] } },
                    ],
                },
            ],
        });
    });

    it('leaves negative operators unchanged', () => {
        expect(
            expandProductVariantFacetValueFilter({
                facetValueId: { notIn: ['facet-1'] },
            }),
        ).toEqual({
            facetValueId: { notIn: ['facet-1'] },
        });
    });

    it('preserves search filters combined with the dashboard OR operator', () => {
        expect(
            expandProductVariantFacetValueFilter(
                {
                    _and: [{ facetValueId: { in: ['facet-1'] } }],
                    name: { contains: 'chair' },
                    sku: { contains: 'chair' },
                },
                LogicalOperator.OR,
            ),
        ).toEqual({
            _and: [
                {
                    _or: [
                        { facetValueId: { in: ['facet-1'] } },
                        { productFacetValueId: { in: ['facet-1'] } },
                    ],
                },
            ],
            name: { contains: 'chair' },
            sku: { contains: 'chair' },
        });
    });
});

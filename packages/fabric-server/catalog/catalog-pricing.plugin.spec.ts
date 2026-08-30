import { buildSchema, extendSchema, getNamedType, isObjectType, parse, print } from 'graphql';
import { describe, expect, it } from 'vitest';

import { ProductVariantService, RequestContext, TransactionalConnection } from '@vendure/core';
import {
    CatalogPricingMath,
    CatalogPricingService,
    ProductVariantPricingResolver,
    SearchResultPricingResolver,
    catalogPricingApiExtensions,
} from './catalog-pricing.plugin';
import { aridaCatalogCustomFields } from './custom-fields';

describe('CatalogPricingMath', () => {
    it('keeps the effective price and hides the display discount at 0%', () => {
        expect(CatalogPricingMath.basePrice(12_345, 0)).toBe(12_345);
        expect(CatalogPricingMath.baseSearchPrice({ value: 12_345 }, 0)).toEqual({ value: 12_345 });
    });

    it('derives a stable base price at 40% in minor units for PDP and search', () => {
        const productPrice = CatalogPricingMath.basePrice(6_000, 40);
        const searchPrice = CatalogPricingMath.baseSearchPrice({ value: 6_000 }, 40);

        expect(productPrice).toBe(10_000);
        expect(searchPrice).toEqual({ value: productPrice });
    });

    it('accepts 99% without dividing by zero', () => {
        expect(CatalogPricingMath.toDiscountPercent(99)).toBe(99);
        expect(CatalogPricingMath.basePrice(1_234, 99)).toBe(123_400);
    });

    it('returns neutral pricing for a grouped range with heterogeneous discounts', async () => {
        const service = makePricingService([
            { id: 'variant-1', price: 6_000, customFields: { discountPercent: 40 } },
            { id: 'variant-2', price: 10_000, customFields: { discountPercent: 20 } },
        ]);
        const resolver = new SearchResultPricingResolver(service);
        const result = groupedResult();

        expect(await resolver.discountPercent({} as RequestContext, result)).toBe(0);
        expect(await resolver.basePrice({} as RequestContext, result)).toEqual({ min: 6_000, max: 10_000 });
        expect(await resolver.basePriceWithTax({} as RequestContext, result)).toEqual({
            min: 6_000,
            max: 10_000,
        });
    });

    it('derives display pricing for a grouped range with homogeneous discounts', async () => {
        const service = makePricingService([
            { id: 'variant-1', price: 6_000, customFields: { discountPercent: 40 } },
            { id: 'variant-2', price: 10_000, customFields: { discountPercent: 40 } },
        ]);
        const resolver = new SearchResultPricingResolver(service);
        const result = groupedResult();

        expect(await resolver.discountPercent({} as RequestContext, result)).toBe(40);
        expect(await resolver.basePrice({} as RequestContext, result)).toEqual({ min: 10_000, max: 16_667 });
    });

    it('keeps neutral pricing for grouped 0% discounts and invalid grouped values', async () => {
        const zeroService = makePricingService([
            { id: 'variant-1', price: 6_000, customFields: { discountPercent: 0 } },
            { id: 'variant-2', price: 10_000, customFields: { discountPercent: 0 } },
        ]);
        const invalidService = makePricingService([
            { id: 'variant-1', price: 6_000, customFields: { discountPercent: 100 } },
            { id: 'variant-2', price: 10_000, customFields: { discountPercent: 100 } },
        ]);

        expect(
            await new SearchResultPricingResolver(zeroService).discountPercent(
                {} as RequestContext,
                groupedResult(),
            ),
        ).toBe(0);
        expect(
            await new SearchResultPricingResolver(invalidService).discountPercent(
                {} as RequestContext,
                groupedResult(),
            ),
        ).toBe(0);
    });

    it('keeps 99% pricing for a homogeneous grouped range', async () => {
        const service = makePricingService([
            { id: 'variant-1', price: 1_234, customFields: { discountPercent: 99 } },
            { id: 'variant-2', price: 2_000, customFields: { discountPercent: 99 } },
        ]);
        const resolver = new SearchResultPricingResolver(service);

        expect(
            await resolver.basePrice({} as RequestContext, {
                ...groupedResult(),
                price: { min: 1_234, max: 2_000 },
            }),
        ).toEqual({ min: 123_400, max: 200_000 });
    });

    it('deduplicates grouped variant lookups within one request context', async () => {
        const counters = { groupedLookups: 0 };
        const service = makePricingService(
            [
                { id: 'variant-1', price: 6_000, customFields: { discountPercent: 40 } },
                { id: 'variant-2', price: 10_000, customFields: { discountPercent: 40 } },
            ],
            counters,
        );
        const resolver = new SearchResultPricingResolver(service);
        const ctx = {} as RequestContext;
        const result = groupedResult();

        await Promise.all([
            resolver.discountPercent(ctx, result),
            resolver.basePrice(ctx, result),
            resolver.basePriceWithTax(ctx, result),
        ]);
        await resolver.discountPercent(ctx, result);

        expect(counters.groupedLookups).toBe(1);

        await resolver.discountPercent({} as RequestContext, result);
        expect(counters.groupedLookups).toBe(2);
    });

    it('uses the representative variant for a non-grouped single-price result', async () => {
        const service = makePricingService([
            { id: 'variant-1', price: 6_000, customFields: { discountPercent: 40 } },
            { id: 'variant-2', price: 10_000, customFields: { discountPercent: 20 } },
        ]);
        const resolver = new SearchResultPricingResolver(service);
        const result = {
            productId: 'product-1',
            productVariantId: 'variant-2',
            price: { value: 10_000 },
            priceWithTax: { value: 10_000 },
        };

        expect(await resolver.discountPercent({} as RequestContext, result)).toBe(20);
        expect(await resolver.basePrice({} as RequestContext, result)).toEqual({ value: 12_500 });
    });

    it('keeps single-variant PDP pricing on the effective variant price', async () => {
        const service = makePricingService([
            { id: 'variant-1', price: 6_000, customFields: { discountPercent: 40 } },
        ]);
        const resolver = new ProductVariantPricingResolver(service, {
            hydratePriceFields: async (_ctx: RequestContext, variant: { price: number }) => variant.price,
        } as unknown as ProductVariantService);
        const variant = {
            id: 'variant-1',
            price: 6_000,
            customFields: { discountPercent: 40 },
        };

        expect(await service.getProductVariantDiscountPercent({} as RequestContext, variant as never)).toBe(
            40,
        );
        expect(await resolver.basePrice({} as RequestContext, variant as never)).toBe(10_000);
    });

    it.each([-1, 100, 40.5, '40', null])('rejects invalid discount value %p', value => {
        expect(CatalogPricingMath.toDiscountPercent(value)).toBeNull();
    });

    it('does not persist a base price and exposes the same display fields on both API types', () => {
        const variantFields = aridaCatalogCustomFields.ProductVariant ?? [];
        expect(variantFields.some(field => field.name === 'basePrice')).toBe(false);
        expect(variantFields.find(field => field.name === 'discountPercent')).toMatchObject({
            type: 'int',
            public: true,
            min: 0,
            max: 99,
        });

        const schema = print(catalogPricingApiExtensions);
        expect(schema).toContain(
            `extend type ProductVariant {
  basePrice: Money!
  basePriceWithTax: Money!
}`,
        );
        expect(schema).toContain('extend type SearchResult');
        expect(schema).toContain('discountPercent: Int!');
        expect(schema).toContain('basePrice: SearchResultPrice!');
    });

    it('composes with the public ProductVariant custom-field schema without duplicate fields', () => {
        const publicCustomFieldSchema = buildSchema(`
            scalar Money
            type ProductVariantCustomFields {
                discountPercent: Int
            }
            type ProductVariant {
                customFields: ProductVariantCustomFields
            }
            type SearchResultPrice {
                value: Int
                min: Int
                max: Int
            }
            type SearchResult {
                price: SearchResultPrice!
                priceWithTax: SearchResultPrice!
            }
        `);

        const composedSchema = extendSchema(
            publicCustomFieldSchema,
            parse(print(catalogPricingApiExtensions)),
        );

        const productVariant = composedSchema.getType('ProductVariant');
        expect(productVariant).toBeDefined();
        expect(composedSchema.getType('SearchResult')).toBeDefined();
        expect(isObjectType(productVariant)).toBe(true);
        if (isObjectType(productVariant)) {
            const fields = productVariant.getFields();
            expect(fields.discountPercent).toBeUndefined();
            expect(fields.basePrice).toBeDefined();
            expect(fields.basePriceWithTax).toBeDefined();
            const customFieldsType = getNamedType(fields.customFields.type);
            expect(isObjectType(customFieldsType)).toBe(true);
            if (isObjectType(customFieldsType)) {
                expect(customFieldsType.getFields().discountPercent).toBeDefined();
            }
        }

        expect(Object.getOwnPropertyNames(ProductVariantPricingResolver.prototype)).not.toContain(
            'discountPercent',
        );

        const schemaWithLegacyDirectField = buildSchema(`
            scalar Money
            type ProductVariant {
                discountPercent: Int!
            }
            type SearchResultPrice {
                value: Int
                min: Int
                max: Int
            }
            type SearchResult {
                price: SearchResultPrice!
                priceWithTax: SearchResultPrice!
            }
        `);
        expect(() =>
            extendSchema(schemaWithLegacyDirectField, parse(print(catalogPricingApiExtensions))),
        ).not.toThrow();
    });
});

function groupedResult() {
    return {
        productId: 'product-1',
        productVariantId: 'variant-1',
        price: { min: 6_000, max: 10_000 },
        priceWithTax: { min: 6_000, max: 10_000 },
    };
}

function makePricingService(
    variants: Array<Record<string, unknown>>,
    counters: { groupedLookups: number } = { groupedLookups: 0 },
): CatalogPricingService {
    const connection = {
        getRepository: () => ({
            find: async () => {
                counters.groupedLookups += 1;
                return variants;
            },
            findOne: async ({ where }: { where: { id: string } }) =>
                variants.find(variant => variant.id === where.id),
        }),
    } as unknown as TransactionalConnection;
    const productVariantService = {
        hydratePriceFields: async (_ctx: RequestContext, variant: { price: number }) => variant.price,
    } as unknown as ProductVariantService;
    return new CatalogPricingService(connection, productVariantService);
}

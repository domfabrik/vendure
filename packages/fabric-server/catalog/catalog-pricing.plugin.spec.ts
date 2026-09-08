import { buildSchema, extendSchema, getNamedType, isObjectType, parse, print } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
} from '@vendure/core';
import {
    catalogPricingApiExtensions,
    CatalogPricingService,
    SearchResultPricingResolver,
} from './catalog-pricing.plugin';

type FixtureVariant = {
    id: string;
    price: number;
    priceWithTax: number;
    currencyCode?: string;
    saleableStockLevel?: number;
    customFields?: { discountPercent?: number | null; oldPrice?: number | null };
    product?: { enabled: boolean; featuredAsset?: { id: string; preview: string } | null };
    featuredAsset?: { id: string; preview: string } | null;
};

describe('CatalogPricingPlugin chosenOffer', () => {
    it('keeps the lowest effective offer and its own base price and discount', async () => {
        const service = makePricingService([
            variant('30', { priceWithTax: 30_000, discountPercent: 20 }),
            variant('36', { priceWithTax: 36_000, discountPercent: 40 }),
        ]);

        await expect(service.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: '30',
            priceWithTax: 30_000,
            basePriceWithTax: 37_500,
            discountPercent: 20,
        });
    });

    it('breaks equal-price ties by larger discount and then a stable variant ID', async () => {
        const higherDiscount = makePricingService([
            variant('10', { priceWithTax: 30_000, discountPercent: 20 }),
            variant('20', { priceWithTax: 30_000, discountPercent: 40 }),
        ]);
        await expect(higherDiscount.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: '20',
            discountPercent: 40,
        });

        const stableId = makePricingService([
            variant('10', { priceWithTax: 30_000, discountPercent: 20 }),
            variant('2', { priceWithTax: 30_000, discountPercent: 20 }),
        ]);
        await expect(stableId.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: '2',
        });
    });

    it('does not borrow a discount from a more expensive variant', async () => {
        const service = makePricingService([
            variant('cheap', { priceWithTax: 30_000, discountPercent: 0 }),
            variant('discounted', { priceWithTax: 36_000, discountPercent: 40 }),
        ]);

        await expect(service.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: 'cheap',
            priceWithTax: 30_000,
            basePriceWithTax: 30_000,
            discountPercent: 0,
        });
    });

    it('ranks tax-inclusive minor-unit prices and preserves their rounded base price', async () => {
        const service = makePricingService([
            variant('lower-net-higher-tax', { price: 29_000, priceWithTax: 30_002, discountPercent: 20 }),
            variant('lowest-tax-inclusive', { price: 30_001, priceWithTax: 30_001, discountPercent: 20 }),
        ]);

        await expect(service.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: 'lowest-tax-inclusive',
            priceWithTax: 30_001,
            basePriceWithTax: 37_501,
        });
    });

    it('skips unsaleable, disabled, wrong-currency and invalid variants and returns null when none remain', async () => {
        const service = makePricingService([
            variant('out-of-stock', { priceWithTax: 1, saleableStockLevel: 0 }),
            variant('disabled-product', { priceWithTax: 1, productEnabled: false }),
            variant('usd', { priceWithTax: 1, currencyCode: 'USD' }),
            variant('zero', { priceWithTax: 0 }),
            variant('invalid', { priceWithTax: Number.NaN }),
        ]);

        await expect(service.getChosenOffer(ctx(), searchResult())).resolves.toBeNull();
    });

    it('uses the request cache for a product without leaking to another request context', async () => {
        const counter = { calls: 0 };
        const service = makePricingService([variant('one', { priceWithTax: 30_000 })], counter);
        const request = ctx();

        await Promise.all([
            service.getChosenOffer(request, searchResult()),
            service.getChosenOffer(request, searchResult()),
        ]);
        expect(counter.calls).toBe(1);
        await service.getChosenOffer(ctx(), searchResult());
        expect(counter.calls).toBe(2);
    });

    it('paginates past the default list page to find a later purchasable offer', async () => {
        const service = makePricingService([
            ...Array.from({ length: 100 }, (_, index) =>
                variant(`unavailable-${index}`, { priceWithTax: 1, saleableStockLevel: 0 }),
            ),
            variant('101st-cheapest', { priceWithTax: 30_000, discountPercent: 20 }),
        ]);

        await expect(service.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: '101st-cheapest',
        });
    });

    it('exposes an additive GraphQL contract with one coherent offer object', async () => {
        const baseSchema = buildSchema(`
            scalar Money
            enum CurrencyCode { RUB USD }
            type SearchResultAsset { id: ID! preview: String! }
            type SearchResultPrice { value: Int min: Int max: Int }
            type SearchResult { productId: ID! productVariantId: ID! price: SearchResultPrice! priceWithTax: SearchResultPrice! }
            type ProductVariant { customFields: ProductVariantCustomFields }
            type ProductVariantCustomFields { discountPercent: Int }
        `);
        const schema = extendSchema(baseSchema, parse(print(catalogPricingApiExtensions)));
        const searchResult = schema.getType('SearchResult');
        expect(isObjectType(searchResult)).toBe(true);
        if (!isObjectType(searchResult)) return;
        const chosenOffer = getNamedType(searchResult.getFields().chosenOffer.type);
        expect(isObjectType(chosenOffer)).toBe(true);
        if (!isObjectType(chosenOffer)) return;
        expect(Object.keys(chosenOffer.getFields())).toEqual([
            'productVariantId',
            'currencyCode',
            'priceWithTax',
            'basePriceWithTax',
            'discountPercent',
            'productAsset',
        ]);

        const resolver = new SearchResultPricingResolver(
            makePricingService([variant('one', { priceWithTax: 30_000 })]),
        );
        await expect(resolver.chosenOffer(ctx(), searchResultParent())).resolves.toMatchObject({
            productVariantId: 'one',
            priceWithTax: 30_000,
        });
    });
});

function variant(
    id: string,
    overrides: {
        price?: number;
        priceWithTax?: number;
        currencyCode?: string;
        saleableStockLevel?: number;
        discountPercent?: number;
        productEnabled?: boolean;
    } = {},
): FixtureVariant {
    return {
        id,
        price: overrides.price ?? overrides.priceWithTax ?? 30_000,
        priceWithTax: overrides.priceWithTax ?? 30_000,
        currencyCode: overrides.currencyCode ?? 'RUB',
        saleableStockLevel: overrides.saleableStockLevel ?? 1,
        customFields: { discountPercent: overrides.discountPercent ?? 0 },
        product: {
            enabled: overrides.productEnabled ?? true,
            featuredAsset: { id: `product-${id}`, preview: `product-${id}.jpg` },
        },
        featuredAsset: { id: `variant-${id}`, preview: `variant-${id}.jpg` },
    };
}

function makePricingService(variants: FixtureVariant[], counter = { calls: 0 }): CatalogPricingService {
    const productVariantService = {
        getVariantsByProductId: async (
            _ctx: RequestContext,
            _productId: string,
            options: { skip?: number; take?: number },
        ) => {
            counter.calls += 1;
            const skip = options.skip ?? 0;
            const take = options.take ?? 100;
            return { items: variants.slice(skip, skip + take), totalItems: variants.length };
        },
        hydratePriceFields: async (
            _ctx: RequestContext,
            item: FixtureVariant,
            field: 'price' | 'priceWithTax' | 'currencyCode',
        ) => item[field],
        getSaleableStockLevel: async (_ctx: RequestContext, item: FixtureVariant) => item.saleableStockLevel,
    } as unknown as ProductVariantService;
    return new CatalogPricingService(
        {} as TransactionalConnection,
        productVariantService,
        new RequestContextCacheService(),
    );
}

function ctx(): RequestContext {
    return { channelId: 'channel-1', currencyCode: 'RUB' } as RequestContext;
}

function searchResult() {
    return searchResultParent();
}

function searchResultParent() {
    return {
        productId: 'product-1',
        productVariantId: 'legacy-variant',
        price: { min: 30_000, max: 36_000 },
        priceWithTax: { min: 30_000, max: 36_000 },
    };
}

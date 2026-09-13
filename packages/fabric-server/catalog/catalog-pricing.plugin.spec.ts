import {
    ProductVariant,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
} from '@vendure/core';
import { buildSchema, extendSchema, getNamedType, isObjectType, parse, print } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
    catalogPricingApiExtensions,
    CatalogPricingService,
    ProductVariantPricingResolver,
    SearchResultPricingResolver,
} from './catalog-pricing.plugin';

type FixtureVariant = {
    id: string;
    price: number;
    priceWithTax: number;
    currencyCode?: string;
    taxRateApplied?: { netPriceOf(grossPrice: number): number };
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

    it('returns the explicit whole-ruble source base instead of reconstructing it from a floored price', async () => {
        const productVariant = variant('cheap', {
            price: 60_000,
            priceWithTax: 64_900,
            oldPrice: 999,
            discountPercent: 35,
        });
        const resolver = makeProductVariantResolver(productVariant, 20);

        await expect(
            resolver.basePriceWithTax(ctx(), productVariant as unknown as ProductVariant),
        ).resolves.toBe(99_900);
        await expect(resolver.basePrice(ctx(), productVariant as unknown as ProductVariant)).resolves.toBe(
            83_250,
        );
    });

    it('uses the stored discount for the badge even when floor changes observed savings', async () => {
        const productVariant = variant('small', {
            price: 1_200,
            priceWithTax: 1_200,
            oldPrice: 19,
            discountPercent: 35,
        });
        const service = makePricingService([productVariant]);

        await expect(
            service.getProductVariantDiscountPercent(ctx(), productVariant as unknown as ProductVariant),
        ).resolves.toBe(35);
    });

    it.each([
        ['missing badge', undefined],
        ['invalid badge', 100],
    ])('does not use an oldPrice below effective price with a %s', async (_label, discountPercent) => {
        const productVariant = variant('below-effective', {
            price: 60_000,
            priceWithTax: 64_900,
            oldPrice: 600,
            discountPercent,
        });

        await expect(
            makeProductVariantResolver(productVariant, 20).basePriceWithTax(
                ctx(),
                productVariant as unknown as ProductVariant,
            ),
        ).resolves.toBe(64_900);
    });

    it('converts explicit gross base to net using the hydrated variant tax rate, including zero tax', async () => {
        const productVariant = variant('taxed', {
            price: 78_000,
            priceWithTax: 78_000,
            oldPrice: 1_200,
            discountPercent: 35,
        });

        await expect(
            makeProductVariantResolver(productVariant, 20).basePrice(
                ctx(),
                productVariant as unknown as ProductVariant,
            ),
        ).resolves.toBe(100_000);
        await expect(
            makeProductVariantResolver(productVariant, 0).basePrice(
                ctx(),
                productVariant as unknown as ProductVariant,
            ),
        ).resolves.toBe(120_000);
    });

    it.each([
        ['null', null, 'RUB'],
        ['zero', 0, 'RUB'],
        ['negative', -1, 'RUB'],
        ['fractional', 999.5, 'RUB'],
        ['NaN', Number.NaN, 'RUB'],
        ['unsafe integer', Number.MAX_SAFE_INTEGER + 1, 'RUB'],
        ['overflow after kopeks conversion', Number.MAX_SAFE_INTEGER, 'RUB'],
        ['base does not exceed the discounted offer', 649, 'RUB'],
        ['non-RUB', 999, 'USD'],
    ])(
        'uses the compatibility fallback for invalid explicit base (%s)',
        async (_label, oldPrice, currencyCode) => {
            const productVariant = variant('fallback', {
                price: 60_000,
                priceWithTax: 64_900,
                oldPrice,
                discountPercent: 35,
                currencyCode,
            });
            const resolver = makeProductVariantResolver(productVariant, 20);

            await expect(
                resolver.basePriceWithTax(ctx(), productVariant as unknown as ProductVariant),
            ).resolves.toBe(99_846);
        },
    );

    it('keeps price, exact old-price base and discount on the same cheapest chosen offer', async () => {
        const service = makePricingService([
            variant('cheap', {
                priceWithTax: 64_900,
                oldPrice: 999,
                discountPercent: 35,
            }),
            variant('expensive', {
                priceWithTax: 65_000,
                oldPrice: 1_000,
                discountPercent: 35,
            }),
        ]);

        await expect(service.getChosenOffer(ctx(), searchResult())).resolves.toMatchObject({
            productVariantId: 'cheap',
            priceWithTax: 64_900,
            basePriceWithTax: 99_900,
            discountPercent: 35,
        });
    });

    it('does not expose oldPrice as Money outside a RUB request context', async () => {
        const productVariant = variant('foreign', {
            price: 60_000,
            priceWithTax: 64_900,
            oldPrice: 999,
            discountPercent: 35,
            currencyCode: 'USD',
        });
        const resolver = makeProductVariantResolver(productVariant, 20);

        await expect(
            resolver.basePriceWithTax(ctx('USD'), productVariant as unknown as ProductVariant),
        ).resolves.toBe(99_846);
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
        const searchResultType = schema.getType('SearchResult');
        expect(isObjectType(searchResultType)).toBe(true);
        if (!isObjectType(searchResultType)) return;
        const chosenOffer = getNamedType(searchResultType.getFields().chosenOffer.type);
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
        oldPrice?: number | null;
        productEnabled?: boolean;
    } = {},
): FixtureVariant {
    return {
        id,
        price: overrides.price ?? overrides.priceWithTax ?? 30_000,
        priceWithTax: overrides.priceWithTax ?? 30_000,
        currencyCode: overrides.currencyCode ?? 'RUB',
        saleableStockLevel: overrides.saleableStockLevel ?? 1,
        customFields: {
            discountPercent: overrides.discountPercent ?? 0,
            oldPrice: overrides.oldPrice,
        },
        taxRateApplied: { netPriceOf: grossPrice => Math.round(grossPrice / 1.2) },
        product: {
            enabled: overrides.productEnabled ?? true,
            featuredAsset: { id: `product-${id}`, preview: `product-${id}.jpg` },
        },
        featuredAsset: { id: `variant-${id}`, preview: `variant-${id}.jpg` },
    };
}

function makePricingService(variants: FixtureVariant[], counter = { calls: 0 }): CatalogPricingService {
    const productVariantService = {
        getVariantsByProductId: (
            _ctx: RequestContext,
            _productId: string,
            options: { skip?: number; take?: number },
        ) => {
            counter.calls += 1;
            const skip = options.skip ?? 0;
            const take = options.take ?? 100;
            return { items: variants.slice(skip, skip + take), totalItems: variants.length };
        },
        hydratePriceFields: (
            _ctx: RequestContext,
            item: FixtureVariant,
            field: 'price' | 'priceWithTax' | 'currencyCode' | 'taxRateApplied',
        ) => item[field],
        getSaleableStockLevel: (_ctx: RequestContext, item: FixtureVariant) => item.saleableStockLevel,
    } as unknown as ProductVariantService;
    return new CatalogPricingService(
        {} as TransactionalConnection,
        productVariantService,
        new RequestContextCacheService(),
    );
}

function makeProductVariantResolver(item: FixtureVariant, taxRate: number): ProductVariantPricingResolver {
    const productVariantService = {
        hydratePriceFields: (
            _ctx: RequestContext,
            variantItem: FixtureVariant,
            field: 'price' | 'priceWithTax' | 'currencyCode' | 'taxRateApplied',
        ) => {
            if (field === 'taxRateApplied') {
                return { netPriceOf: (grossPrice: number) => Math.round(grossPrice / (1 + taxRate / 100)) };
            }
            return variantItem[field];
        },
    } as unknown as ProductVariantService;
    const pricingService = new CatalogPricingService(
        {} as TransactionalConnection,
        productVariantService,
        new RequestContextCacheService(),
    );
    return new ProductVariantPricingResolver(pricingService, productVariantService);
}

function ctx(currencyCode = 'RUB'): RequestContext {
    return { channelId: 'channel-1', currencyCode } as RequestContext;
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

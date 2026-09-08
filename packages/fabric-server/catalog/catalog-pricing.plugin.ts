import { Injectable } from '@nestjs/common';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Ctx,
    CurrencyCode,
    PluginCommonModule,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
    VendurePlugin,
} from '@vendure/core';
import gql from 'graphql-tag';

type SearchPrice = { value: number } | { min: number; max: number };

type SearchResultParent = {
    productId: ID | string;
    productVariantId: ID | string;
    price: SearchPrice;
    priceWithTax: SearchPrice;
};

type CatalogChosenOffer = {
    productVariantId: ID | string;
    currencyCode: CurrencyCode;
    priceWithTax: number;
    basePriceWithTax: number;
    discountPercent: number;
    productAsset: { id: ID | string; preview: string } | null;
};

type VariantCustomFields = {
    discountPercent?: number | null;
    oldPrice?: number | null;
};

export class CatalogPricingMath {
    static toDiscountPercent(value: unknown): number | null {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 99) {
            return null;
        }
        return value;
    }

    static deriveDiscountPercent(oldPrice: unknown, effectivePrice: number): number | null {
        if (typeof oldPrice !== 'number' || !Number.isInteger(oldPrice) || oldPrice <= 0) {
            return null;
        }
        if (effectivePrice <= 0 || effectivePrice >= oldPrice) {
            return null;
        }
        const percent = Math.round(((oldPrice - effectivePrice) / oldPrice) * 100);
        return this.toDiscountPercent(percent);
    }

    static basePrice(price: number, discountPercent: number): number {
        if (!Number.isFinite(price) || price <= 0) {
            return 0;
        }
        if (discountPercent <= 0) {
            return Math.round(price);
        }
        const denominator = 100 - discountPercent;
        if (denominator <= 0) {
            return Math.round(price);
        }
        return Math.round((price * 100) / denominator);
    }

    static baseSearchPrice(price: SearchPrice, discountPercent: number): SearchPrice {
        if ('value' in price) {
            return { value: this.basePrice(price.value, discountPercent) };
        }
        return {
            min: this.basePrice(price.min, discountPercent),
            max: this.basePrice(price.max, discountPercent),
        };
    }
}

@Injectable()
export class CatalogPricingService {
    constructor(
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
        private requestContextCache: RequestContextCacheService,
    ) {}

    async getProductVariantDiscountPercent(
        ctx: RequestContext,
        productVariant: ProductVariant,
    ): Promise<number> {
        const effectivePrice =
            typeof productVariant.price === 'number'
                ? productVariant.price
                : await this.productVariantService.hydratePriceFields(ctx, productVariant, 'price');
        const customFields = await this.getVariantCustomFields(ctx, productVariant);
        return this.resolveDiscountPercent(customFields, effectivePrice);
    }

    async getSearchResultDiscountPercent(
        ctx: RequestContext,
        searchResult: SearchResultParent,
    ): Promise<number> {
        const effectivePrice =
            'value' in searchResult.price ? searchResult.price.value : searchResult.price.min;
        const customFields = await this.getVariantCustomFieldsById(ctx, searchResult.productVariantId);
        return this.resolveDiscountPercent(customFields, effectivePrice);
    }

    /**
     * Search results aggregate a product's variants, so their price range and representative
     * variant cannot safely be combined with one another. This returns one concrete variant
     * for all catalog-card offer fields.
     */
    async getChosenOffer(
        ctx: RequestContext,
        searchResult: SearchResultParent,
    ): Promise<CatalogChosenOffer | null> {
        const cacheKey = `catalog-chosen-offer-${ctx.channelId}-${ctx.currencyCode}-${searchResult.productId}`;
        return this.requestContextCache.get(ctx, cacheKey, () =>
            this.findChosenOffer(ctx, searchResult.productId),
        );
    }

    private async findChosenOffer(
        ctx: RequestContext,
        productId: ID | string,
    ): Promise<CatalogChosenOffer | null> {
        const variants: ProductVariant[] = [];
        const pageSize = 100;
        let skip = 0;
        let pageCount = 0;
        let totalItems = 0;
        do {
            const page = await this.productVariantService.getVariantsByProductId(
                ctx,
                productId as ID,
                { skip, take: pageSize },
                ['featuredAsset', 'product', 'product.featuredAsset'] as any,
            );
            variants.push(...page.items);
            totalItems = page.totalItems;
            skip += page.items.length;
            pageCount += 1;
        } while (
            skip < totalItems &&
            pageCount < Math.ceil(totalItems / pageSize) &&
            skip > 0
        );
        const candidates = await Promise.all(
            variants.map(async variant => {
                if (variant.product?.enabled === false) {
                    return null;
                }
                try {
                    const [price, priceWithTax, currencyCode, saleableStockLevel] = await Promise.all([
                        this.productVariantService.hydratePriceFields(ctx, variant, 'price'),
                        this.productVariantService.hydratePriceFields(ctx, variant, 'priceWithTax'),
                        this.productVariantService.hydratePriceFields(ctx, variant, 'currencyCode'),
                        this.productVariantService.getSaleableStockLevel(ctx, variant),
                    ]);
                    if (
                        currencyCode !== ctx.currencyCode ||
                        !Number.isSafeInteger(priceWithTax) ||
                        priceWithTax <= 0 ||
                        saleableStockLevel <= 0
                    ) {
                        return null;
                    }
                    const discountPercent = this.resolveDiscountPercent(
                        variant.customFields as VariantCustomFields,
                        price,
                    );
                    const productAsset = variant.featuredAsset ?? variant.product?.featuredAsset ?? null;
                    return {
                        productVariantId: variant.id,
                        currencyCode,
                        priceWithTax,
                        basePriceWithTax: CatalogPricingMath.basePrice(priceWithTax, discountPercent),
                        discountPercent,
                        productAsset: productAsset
                            ? { id: productAsset.id, preview: productAsset.preview }
                            : null,
                    } satisfies CatalogChosenOffer;
                } catch {
                    // A variant without a price in the active context is not an offer for this request.
                    return null;
                }
            }),
        );
        const validCandidates = candidates.filter(
            (candidate): candidate is CatalogChosenOffer => candidate !== null,
        );
        validCandidates.sort((left, right) => {
            if (left.priceWithTax !== right.priceWithTax) {
                return left.priceWithTax - right.priceWithTax;
            }
            if (left.discountPercent !== right.discountPercent) {
                return right.discountPercent - left.discountPercent;
            }
            return compareStableIds(left.productVariantId, right.productVariantId);
        });
        return validCandidates[0] ?? null;
    }

    async getVariantCustomFields(
        ctx: RequestContext,
        productVariant: ProductVariant,
    ): Promise<VariantCustomFields> {
        if (productVariant.customFields) {
            return productVariant.customFields as VariantCustomFields;
        }
        return this.getVariantCustomFieldsById(ctx, productVariant.id);
    }

    async getVariantCustomFieldsById(
        ctx: RequestContext,
        variantId: ID | string,
    ): Promise<VariantCustomFields> {
        const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
            where: { id: variantId as ID },
        });
        return (variant?.customFields as VariantCustomFields | undefined) ?? {};
    }

    private resolveDiscountPercent(customFields: VariantCustomFields, effectivePrice: number): number {
        const stored = CatalogPricingMath.toDiscountPercent(customFields.discountPercent);
        if (stored != null) {
            return stored;
        }
        const derived = CatalogPricingMath.deriveDiscountPercent(customFields.oldPrice, effectivePrice);
        return derived ?? 0;
    }
}

function compareStableIds(left: ID | string, right: ID | string): number {
    const a = String(left);
    const b = String(right);
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
        return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
    }
    return a.localeCompare(b);
}

@Resolver('ProductVariant')
export class ProductVariantPricingResolver {
    constructor(
        private pricingService: CatalogPricingService,
        private productVariantService: ProductVariantService,
    ) {}

    @ResolveField()
    async basePrice(@Ctx() ctx: RequestContext, @Parent() productVariant: ProductVariant): Promise<number> {
        const discountPercent = await this.pricingService.getProductVariantDiscountPercent(
            ctx,
            productVariant,
        );
        const effectivePrice = await this.productVariantService.hydratePriceFields(
            ctx,
            productVariant,
            'price',
        );
        return CatalogPricingMath.basePrice(effectivePrice, discountPercent);
    }

    @ResolveField()
    async basePriceWithTax(
        @Ctx() ctx: RequestContext,
        @Parent() productVariant: ProductVariant,
    ): Promise<number> {
        const discountPercent = await this.pricingService.getProductVariantDiscountPercent(
            ctx,
            productVariant,
        );
        const effectivePrice = await this.productVariantService.hydratePriceFields(
            ctx,
            productVariant,
            'priceWithTax',
        );
        return CatalogPricingMath.basePrice(effectivePrice, discountPercent);
    }
}

@Resolver('SearchResult')
export class SearchResultPricingResolver {
    constructor(private pricingService: CatalogPricingService) {}

    @ResolveField()
    async discountPercent(
        @Ctx() ctx: RequestContext,
        @Parent() searchResult: SearchResultParent,
    ): Promise<number> {
        return this.pricingService.getSearchResultDiscountPercent(ctx, searchResult);
    }

    @ResolveField()
    async basePrice(@Ctx() ctx: RequestContext, @Parent() searchResult: SearchResultParent) {
        const discountPercent = await this.pricingService.getSearchResultDiscountPercent(ctx, searchResult);
        return CatalogPricingMath.baseSearchPrice(searchResult.price, discountPercent);
    }

    @ResolveField()
    async basePriceWithTax(@Ctx() ctx: RequestContext, @Parent() searchResult: SearchResultParent) {
        const discountPercent = await this.pricingService.getSearchResultDiscountPercent(ctx, searchResult);
        return CatalogPricingMath.baseSearchPrice(searchResult.priceWithTax, discountPercent);
    }

    @ResolveField()
    async chosenOffer(
        @Ctx() ctx: RequestContext,
        @Parent() searchResult: SearchResultParent,
    ): Promise<CatalogChosenOffer | null> {
        return this.pricingService.getChosenOffer(ctx, searchResult);
    }
}

export const catalogPricingApiExtensions = gql`
    extend type ProductVariant {
        basePrice: Money!
        basePriceWithTax: Money!
    }

    extend type SearchResult {
        discountPercent: Int!
        basePrice: SearchResultPrice!
        basePriceWithTax: SearchResultPrice!
        chosenOffer: CatalogChosenOffer
    }

    type CatalogChosenOffer {
        productVariantId: ID!
        currencyCode: CurrencyCode!
        priceWithTax: Money!
        basePriceWithTax: Money!
        discountPercent: Int!
        productAsset: SearchResultAsset
    }
`;

@VendurePlugin({
    imports: [PluginCommonModule],
    shopApiExtensions: {
        schema: catalogPricingApiExtensions,
        resolvers: [ProductVariantPricingResolver, SearchResultPricingResolver],
    },
    providers: [CatalogPricingService],
})
export class CatalogPricingPlugin {}

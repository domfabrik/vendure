import { Injectable } from '@nestjs/common';
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    PluginCommonModule,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    TransactionalConnection,
    VendurePlugin,
} from '@vendure/core';
import { ID } from '@vendure/common/lib/shared-types';
import gql from 'graphql-tag';

type SearchPrice = { value: number } | { min: number; max: number };

type SearchResultParent = {
    productVariantId: ID | string;
    price: SearchPrice;
    priceWithTax: SearchPrice;
};

type VariantCustomFields = {
    discountPercent?: number | null;
    oldPrice?: number | null;
};

class CatalogPricingMath {
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
class CatalogPricingService {
    constructor(
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
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
        const effectivePrice = 'value' in searchResult.price ? searchResult.price.value : searchResult.price.min;
        const customFields = await this.getVariantCustomFieldsById(ctx, searchResult.productVariantId);
        return this.resolveDiscountPercent(customFields, effectivePrice);
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

    async getVariantCustomFieldsById(ctx: RequestContext, variantId: ID | string): Promise<VariantCustomFields> {
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

@Resolver('ProductVariant')
export class ProductVariantPricingResolver {
    constructor(
        private pricingService: CatalogPricingService,
        private productVariantService: ProductVariantService,
    ) {}

    @ResolveField()
    async basePrice(@Ctx() ctx: RequestContext, @Parent() productVariant: ProductVariant): Promise<number> {
        const discountPercent = await this.pricingService.getProductVariantDiscountPercent(ctx, productVariant);
        const effectivePrice = await this.productVariantService.hydratePriceFields(ctx, productVariant, 'price');
        return CatalogPricingMath.basePrice(effectivePrice, discountPercent);
    }

    @ResolveField()
    async basePriceWithTax(
        @Ctx() ctx: RequestContext,
        @Parent() productVariant: ProductVariant,
    ): Promise<number> {
        const discountPercent = await this.pricingService.getProductVariantDiscountPercent(ctx, productVariant);
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
}

const catalogPricingApiExtensions = gql`
    extend type ProductVariant {
        basePrice: Money!
        basePriceWithTax: Money!
    }

    extend type SearchResult {
        discountPercent: Int!
        basePrice: SearchResultPrice!
        basePriceWithTax: SearchResultPrice!
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

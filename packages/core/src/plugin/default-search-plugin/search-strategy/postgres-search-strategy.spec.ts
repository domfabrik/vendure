import { describe, expect, it } from 'vitest';

import { SearchEvent } from '../../../event-bus/events/search-event';
import { ShopFulltextSearchResolver } from '../api/fulltext-search.resolver';
import { FulltextSearchService } from '../fulltext-search.service';

import { PostgresSearchStrategy } from './postgres-search-strategy';

function createContext(apiType: 'admin' | 'shop') {
    return {
        apiType,
        channelId: 1,
        languageCode: 'en',
        channel: { defaultLanguageCode: 'en', defaultCurrencyCode: 'USD' },
    } as any;
}

const rawItems = [
    {
        si_sku: 'ALPHA-OAK', si_enabled: true, si_slug: 'alpha-chair', si_price: 100,
        si_priceWithTax: 120, si_productVariantId: 'variant-1', si_languageCode: 'en',
        si_productId: 'product-1', si_productName: 'Alpha chair',
        si_productVariantName: 'Alpha chair / Oak', si_description: 'Oak chair',
        si_facetIds: 'material,color', si_facetValueIds: 'red,wood', si_collectionIds: 'chairs',
        si_channelIds: '1', si_inStock: true,
    },
    {
        si_sku: 'ALPHA-METAL', si_enabled: true, si_slug: 'alpha-chair', si_price: 300,
        si_priceWithTax: 360, si_productVariantId: 'variant-2', si_languageCode: 'en',
        si_productId: 'product-1', si_productName: 'Alpha chair',
        si_productVariantName: 'Alpha chair / Metal', si_description: 'Metal chair',
        si_facetIds: 'material,color', si_facetValueIds: 'red,metal', si_collectionIds: 'chairs',
        si_channelIds: '1', si_inStock: false,
    },
    {
        si_sku: 'BETA-WOOD', si_enabled: true, si_slug: 'beta-chair', si_price: 200,
        si_priceWithTax: 240, si_productVariantId: 'variant-3', si_languageCode: 'en',
        si_productId: 'product-2', si_productName: 'Beta chair',
        si_productVariantName: 'Beta chair / Wood', si_description: 'Wood chair',
        si_facetIds: 'material,color', si_facetValueIds: 'blue,wood', si_collectionIds: 'chairs',
        si_channelIds: '1', si_inStock: true,
    },
];

type FixtureCalls = {
    repositoryAccesses: number;
    builders: { item: number; count: number; facet: number };
    executions: { item: number; count: number; facet: number };
    predicates: string[];
    limits: number[];
    offsets: number[];
    orderBy: Array<[string, string]>;
};

function createFixture() {
    const calls: FixtureCalls = {
        repositoryAccesses: 0,
        builders: { item: 0, count: 0, facet: 0 },
        executions: { item: 0, count: 0, facet: 0 },
        predicates: [],
        limits: [], offsets: [], orderBy: [],
    };
    let countBuilder: ReturnType<typeof createQueryBuilder>;

    function createQueryBuilder() {
        const state = {
            kind: 'unknown' as 'unknown' | 'item' | 'count' | 'facet',
            parameters: {} as Record<string, any>,
            groupBy: '', limit: Number.POSITIVE_INFINITY, offset: 0,
            orderBy: [] as Array<[string, string]>,
        };
        const queryBuilder: Record<string, any> = {};
        const applyWhere = (condition?: any, parameters?: Record<string, any>) => {
            if (condition?.whereFactory) {
                condition.whereFactory(queryBuilder);
            }
            if (typeof condition === 'string') {
                calls.predicates.push(condition);
            }
            Object.assign(state.parameters, parameters);
            return queryBuilder;
        };

        queryBuilder.select = (selection: unknown) => {
            if (Array.isArray(selection)) {
                state.kind = 'facet';
                calls.builders.facet++;
            }
            return queryBuilder;
        };
        queryBuilder.addSelect = () => queryBuilder;
        queryBuilder.where = applyWhere;
        queryBuilder.andWhere = applyWhere;
        queryBuilder.orWhere = applyWhere;
        queryBuilder.setParameters = (parameters: Record<string, any>) => {
            Object.assign(state.parameters, parameters);
            return queryBuilder;
        };
        queryBuilder.groupBy = (groupBy: string) => {
            state.groupBy = groupBy;
            return queryBuilder;
        };
        queryBuilder.addOrderBy = (column: string, direction: string) => {
            state.orderBy.push([column, direction]);
            calls.orderBy.push([column, direction]);
            return queryBuilder;
        };
        queryBuilder.leftJoin = () => queryBuilder;
        queryBuilder.limit = (limit: number) => {
            state.kind = 'item';
            state.limit = limit;
            calls.builders.item++;
            calls.limits.push(limit);
            return queryBuilder;
        };
        queryBuilder.offset = (offset: number) => {
            state.offset = offset;
            calls.offsets.push(offset);
            return queryBuilder;
        };
        queryBuilder.escape = (value: string) => `"${value}"`;
        queryBuilder.getQuery = () => {
            state.kind = 'count';
            calls.builders.count++;
            countBuilder = queryBuilder;
            return 'SELECT controlled fixture';
        };
        queryBuilder.getParameters = () => state.parameters;
        queryBuilder.getRawMany = () => {
            if (state.kind === 'facet') {
                calls.executions.facet++;
                return Promise.resolve(getFacetRows(queryBuilder));
            }
            calls.executions.item++;
            return Promise.resolve(getItemRows(queryBuilder));
        };
        queryBuilder.__state = state;
        return queryBuilder;
    }

    function getFilteredRows(queryBuilder: ReturnType<typeof createQueryBuilder>) {
        const parameters = queryBuilder.__state.parameters as Record<string, any>;
        const facetValueIds = Object.entries(parameters)
            .filter(([name]) => name.startsWith('_'))
            .map(([, value]) => String(value));
        return rawItems.filter(item => {
            const itemFacetValueIds = item.si_facetValueIds.split(',');
            return facetValueIds.every(id => itemFacetValueIds.includes(id));
        });
    }

    function isGroupedByProduct(queryBuilder: ReturnType<typeof createQueryBuilder>) {
        return queryBuilder.__state.groupBy === 'si.productId';
    }

    function getGroupedRows(queryBuilder: ReturnType<typeof createQueryBuilder>) {
        const rows = getFilteredRows(queryBuilder);
        if (!isGroupedByProduct(queryBuilder)) {
            return rows;
        }
        return Array.from(new Set(rows.map(item => item.si_productId))).map(productId => {
            const variants = rows.filter(item => item.si_productId === productId);
            const prices = variants.map(item => item.si_price);
            const pricesWithTax = variants.map(item => item.si_priceWithTax);
            return {
                ...variants[0],
                si_facetIds: variants.map(item => item.si_facetIds).join(','),
                si_facetValueIds: variants.map(item => item.si_facetValueIds).join(','),
                minPrice: Math.min(...prices), maxPrice: Math.max(...prices),
                minPriceWithTax: Math.min(...pricesWithTax), maxPriceWithTax: Math.max(...pricesWithTax),
            };
        });
    }

    function getItemRows(queryBuilder: ReturnType<typeof createQueryBuilder>) {
        const state = queryBuilder.__state;
        const rows = [...getGroupedRows(queryBuilder)];
        for (const [column, direction] of [...state.orderBy].reverse()) {
            if (column === '"si_price"') {
                rows.sort((a, b) => direction === 'DESC' ? b.si_price - a.si_price : a.si_price - b.si_price);
            }
        }
        const offset = Number(state.offset);
        return rows.slice(offset, offset + Number(state.limit));
    }

    function getFacetRows(queryBuilder: ReturnType<typeof createQueryBuilder>) {
        return getGroupedRows(queryBuilder).map(item => ({ facetValues: item.si_facetValueIds }));
    }

    const strategy = new PostgresSearchStrategy() as any;
    strategy.connection = {
        getRepository: () => {
            calls.repositoryAccesses++;
            return { createQueryBuilder };
        },
        rawConnection: {
            createQueryBuilder: () => ({
                select: () => ({
                    from: () => ({
                        setParameters: () => ({
                            getRawOne: () => {
                                calls.executions.count++;
                                return Promise.resolve({ total: getGroupedRows(countBuilder).length });
                            },
                        }),
                    }),
                }),
            }),
        },
    };
    strategy.options = { indexStockStatus: true };
    return { calls, strategy };
}

function createService(strategy: PostgresSearchStrategy) {
    const published: SearchEvent[] = [];
    const service = Object.create(FulltextSearchService.prototype);
    service._searchStrategy = strategy;
    service.eventBus = {
        publish: (event: SearchEvent) => {
            published.push(event);
            return Promise.resolve();
        },
    };
    service.facetValueService = {
        findByIds: (_ctx: unknown, ids: string[]) =>
            Promise.resolve(ids.map(id => ({ id, facet: { isPrivate: false } }))),
    };
    return { published, service: service as FulltextSearchService };
}

async function runShopResolver(input: Record<string, any>) {
    const fixture = createFixture();
    const { published, service } = createService(fixture.strategy);
    const resolver = new ShopFulltextSearchResolver(service);
    const ctx = createContext('shop');
    const result = await resolver.search(ctx, { input } as any);
    const facetValues = await resolver.facetValues(ctx, result as any);
    return {
        ...fixture,
        facetCounts: Object.fromEntries(facetValues.map(item => [String(item.facetValue.id), item.count])),
        published,
        result,
    };
}

describe('PostgresSearchStrategy.getSearchResults', () => {
    it('does not access the repository or create item SQL for an explicit Shop take of zero', async () => {
        const calls = { repository: 0, itemBuilders: 0, itemSql: 0 };
        const strategy = new PostgresSearchStrategy() as any;
        strategy.connection = {
            getRepository: () => {
                calls.repository++;
                throw new Error('the item repository must not be accessed');
            },
        };

        await expect(strategy.getSearchResults(createContext('shop'), { take: 0 } as any, true)).resolves.toEqual([]);
        expect(calls).toEqual({ repository: 0, itemBuilders: 0, itemSql: 0 });
    });

    it.each([
        ['admin', 0, 25],
        ['shop', undefined, 25],
        ['shop', 24, 24],
    ] as const)('keeps the item path and limit for %s take=%s', async (apiType, take, expectedLimit) => {
        const fixture = createFixture();
        const items = await fixture.strategy.getSearchResults(createContext(apiType), { take } as any, true);

        expect(items).toHaveLength(3);
        expect(fixture.calls.repositoryAccesses).toBe(1);
        expect(fixture.calls.builders.item).toBe(1);
        expect(fixture.calls.executions.item).toBe(1);
        expect(fixture.calls.limits).toEqual([expectedLimit]);
        expect(fixture.calls.offsets).toEqual([0]);
    });

    it('preserves nonzero skip, price sort, deterministic order, and mapped price and stock values', async () => {
        const fixture = createFixture();
        const items = await fixture.strategy.getSearchResults(
            createContext('shop'),
            { take: 2, skip: 1, sort: { price: 'DESC' } } as any,
            true,
        );

        expect(items.map(item => item.productVariantId)).toEqual(['variant-3', 'variant-1']);
        expect(items.map(item => item.price)).toEqual([{ value: 200 }, { value: 100 }]);
        expect(items.map(item => item.priceWithTax)).toEqual([{ value: 240 }, { value: 120 }]);
        expect(items.map(item => item.inStock)).toEqual([true, true]);
        expect(items.map(item => item.currencyCode)).toEqual(['USD', 'USD']);
        expect(fixture.calls.limits).toEqual([2]);
        expect(fixture.calls.offsets).toEqual([1]);
        expect(fixture.calls.orderBy).toEqual([
            ['"si_price"', 'DESC'],
            ['"si_productVariantId"', 'ASC'],
        ]);
    });

    it('uses the expression-GIN-compatible collection slug predicate', async () => {
        const fixture = createFixture();

        await fixture.strategy.getSearchResults(
            createContext('shop'),
            { collectionSlug: 'chairs', take: 10 } as any,
            true,
        );

        expect(fixture.calls.predicates).toContain(
            "string_to_array(si.collectionSlugs, ',') @> ARRAY[:collectionSlug]::text[]",
        );
    });
});

describe.each([true, false])('Shop resolver eager path with groupByProduct=%s', groupByProduct => {
    it.each([
        ['filtered', 'red', true],
        ['empty', 'missing', false],
    ] as const)('preserves input-sensitive total and facet counts for %s results', async (_name, facetId, hasResults) => {
        const input = { groupByProduct, facetValueIds: [facetId], take: 0 };
        const zero = await runShopResolver(input);
        const control = await runShopResolver({ ...input, take: 10 });
        const expectedTotal = hasResults ? (groupByProduct ? 1 : 2) : 0;
        const expectedFacetCounts = hasResults
            ? groupByProduct
                ? { red: 1, wood: 1, metal: 1 }
                : { red: 2, wood: 1, metal: 1 }
            : {};

        expect(zero.result.items).toEqual([]);
        expect(zero.result.totalItems).toBe(expectedTotal);
        expect(zero.result.totalItems).toBe(control.result.totalItems);
        expect(zero.facetCounts).toEqual(expectedFacetCounts);
        expect(zero.facetCounts).toEqual(control.facetCounts);
        expect(control.result.items).toHaveLength(expectedTotal);
        expect(zero.calls.repositoryAccesses).toBe(2);
        expect(zero.calls.builders).toEqual({ item: 0, count: 1, facet: 1 });
        expect(zero.calls.executions).toEqual({ item: 0, count: 1, facet: 1 });
        expect(control.calls.repositoryAccesses).toBe(3);
        expect(control.calls.builders).toEqual({ item: 1, count: 1, facet: 1 });
        expect(control.calls.executions).toEqual({ item: 1, count: 1, facet: 1 });
        expect(zero.published).toHaveLength(1);
        expect(zero.published[0]).toBeInstanceOf(SearchEvent);
        expect(zero.published[0].input).toBe(input);
    });

    if (groupByProduct) {
        it('does not invoke selected item field resolvers for the facet-only response', async () => {
            const zero = await runShopResolver({ groupByProduct, facetValueIds: ['red'], take: 0 });
            const control = await runShopResolver({ groupByProduct, facetValueIds: ['red'], take: 10 });
            const zeroItemFieldCalls = { price: 0, stock: 0, chosenOffer: 0 };
            const controlItemFieldCalls = { price: 0, stock: 0, chosenOffer: 0 };
            const resolveSelectedItemFields = (
                items: typeof zero.result.items,
                calls: typeof zeroItemFieldCalls,
            ) => {
                for (const _item of items) {
                    calls.price++;
                    calls.stock++;
                    calls.chosenOffer++;
                }
            };

            resolveSelectedItemFields(zero.result.items, zeroItemFieldCalls);
            resolveSelectedItemFields(control.result.items, controlItemFieldCalls);

            expect(zero.result.totalItems).toBe(1);
            expect(zero.facetCounts).toEqual({ red: 1, wood: 1, metal: 1 });
            expect(zeroItemFieldCalls).toEqual({ price: 0, stock: 0, chosenOffer: 0 });
            expect(controlItemFieldCalls).toEqual({ price: 1, stock: 1, chosenOffer: 1 });
        });
    }
});

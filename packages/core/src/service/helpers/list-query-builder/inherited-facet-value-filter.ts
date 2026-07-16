import { LogicalOperator } from '@vendure/common/lib/generated-types';

export const PRODUCT_FACET_VALUE_ID_FILTER = 'productFacetValueId';

type FilterNode = Record<string, unknown>;

function isRecord(value: unknown): value is FilterNode {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNegativeOperator(operator: string, value: unknown): boolean {
    return operator === 'notEq' || operator === 'notIn' || (operator === 'isNull' && value === true);
}

function hasNegativeOperator(operator: FilterNode): boolean {
    return Object.entries(operator).some(
        ([name, value]) => value !== undefined && value !== null && isNegativeOperator(name, value),
    );
}

function createSourceFilter(operator: FilterNode, relationOperator: LogicalOperator): FilterNode {
    const sources = [
        { facetValueId: operator },
        { [PRODUCT_FACET_VALUE_ID_FILTER]: operator },
    ];
    return {
        [relationOperator === LogicalOperator.OR ? '_or' : '_and']: sources,
    };
}

function expandFacetValueOperator(operator: FilterNode, parentOperator: LogicalOperator): FilterNode {
    const groups = Object.entries(operator)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([name, value]) => {
            const sourceOperator = { [name]: value };
            return createSourceFilter(sourceOperator, LogicalOperator.OR);
        });

    if (groups.length === 1) {
        return groups[0];
    }

    return {
        [parentOperator === LogicalOperator.OR ? '_or' : '_and']: groups,
    };
}

function transformNode(node: FilterNode, parentOperator: LogicalOperator): FilterNode {
    const facetValueOperator = node.facetValueId;
    const hasFacetValueFilter = isRecord(facetValueOperator);
    const siblingConditions: FilterNode[] = [];

    for (const [key, value] of Object.entries(node)) {
        if (key === 'facetValueId') {
            continue;
        }
        if ((key === '_and' || key === '_or') && Array.isArray(value)) {
            const nestedOperator = key === '_and' ? LogicalOperator.AND : LogicalOperator.OR;
            siblingConditions.push({
                [key]: value.filter(isRecord).map(child => transformNode(child, nestedOperator)),
            });
        } else {
            siblingConditions.push({ [key]: value });
        }
    }

    if (!hasFacetValueFilter) {
        return Object.assign({}, ...siblingConditions);
    }

    // Negative relation operators have existing ListQueryBuilder semantics. Do not
    // change them implicitly while adding inherited positive facet matching.
    const facetValueCondition = hasNegativeOperator(facetValueOperator)
        ? { facetValueId: facetValueOperator }
        : expandFacetValueOperator(facetValueOperator, parentOperator);
    if (siblingConditions.length === 0) {
        return facetValueCondition;
    }

    return {
        [parentOperator === LogicalOperator.OR ? '_or' : '_and']: [
            facetValueCondition,
            ...siblingConditions,
        ],
    };
}

/**
 * Expands a ProductVariant facet filter to match the variant or its parent Product.
 * The returned AST is still understood by ListQueryBuilder, so channel and soft-delete
 * predicates remain outside the user filter and pagination is applied after filtering.
 */
export function expandProductVariantFacetValueFilter<T extends FilterNode>(
    filter: T | null | undefined,
    filterOperator: LogicalOperator = LogicalOperator.AND,
): T | null | undefined {
    if (!filter) {
        return filter;
    }
    return transformNode(filter, filterOperator) as T;
}

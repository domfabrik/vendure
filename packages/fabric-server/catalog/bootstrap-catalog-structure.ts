import { INestApplicationContext } from '@nestjs/common';
import {
    FacetService,
    LanguageCode,
    ProductOptionGroup,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';

import {
    CATALOG_FACETS,
    OPTION_GROUP_TEMPLATES,
    getFacetTranslations,
} from './catalog-definitions';

type BootstrapSummary = {
    createdCollections: number;
    updatedCollections: number;
    createdFacets: number;
    updatedFacets: number;
};

export async function bootstrapCatalogStructure(app: INestApplicationContext): Promise<BootstrapSummary> {
    const requestContextService = app.get(RequestContextService);
    const facetService = app.get(FacetService);
    const connection = app.get(TransactionalConnection);

    const ctx = await requestContextService.create({
        apiType: 'admin',
        languageCode: LanguageCode.en,
    });

    const summary: BootstrapSummary = {
        createdCollections: 0,
        updatedCollections: 0,
        createdFacets: 0,
        updatedFacets: 0,
    };

    for (const facetDefinition of CATALOG_FACETS) {
        const result = await upsertFacet(ctx, facetService, facetDefinition.code, facetDefinition.name);
        summary.createdFacets += result.created ? 1 : 0;
        summary.updatedFacets += result.updated ? 1 : 0;
    }

    await logOptionGroupTemplates(ctx, connection);

    return summary;
}

async function upsertFacet(
    ctx: RequestContext,
    facetService: FacetService,
    code: string,
    name: string,
) {
    const existing = await facetService.findByCode(ctx, code, ctx.languageCode);
    if (!existing) {
        const created = await facetService.create(ctx, {
            code,
            isPrivate: false,
            translations: getFacetTranslations(name),
        });
        return { facet: created, created: true, updated: false };
    }

    if (existing.name !== name) {
        const updatedFacet = await facetService.update(ctx, {
            id: existing.id,
            code,
            isPrivate: false,
            translations: getFacetTranslations(name),
        });
        return { facet: updatedFacet, created: false, updated: true };
    }

    return { facet: existing, created: false, updated: false };
}

async function logOptionGroupTemplates(ctx: RequestContext, connection: TransactionalConnection) {
    const existingGroups = await connection.getRepository(ctx, ProductOptionGroup).find({
        where: OPTION_GROUP_TEMPLATES.map(template => ({ code: template.code })),
    });
    const existingCodes = new Set(existingGroups.map(group => group.code));

    for (const template of OPTION_GROUP_TEMPLATES) {
        if (!existingCodes.has(template.code)) {
            console.log(
                `[catalog-bootstrap] option group template reserved in code only: ${template.code} (${template.name})`,
            );
        }
    }
}

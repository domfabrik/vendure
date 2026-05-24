import { INestApplicationContext } from '@nestjs/common';
import {
    CollectionService,
    FacetService,
    ID,
    LanguageCode,
    ProductOptionGroup,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';

import {
    CATALOG_COLLECTIONS,
    CATALOG_FACETS,
    OPTION_GROUP_TEMPLATES,
    getCollectionTranslations,
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
    const collectionService = app.get(CollectionService);
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

    for (const collection of CATALOG_COLLECTIONS) {
        const parent = await upsertCollection(ctx, collectionService, {
            name: collection.name,
            slug: collection.slug,
        });
        summary.createdCollections += parent.created ? 1 : 0;
        summary.updatedCollections += parent.updated ? 1 : 0;

        for (const child of collection.children ?? []) {
            const result = await upsertCollection(
                ctx,
                collectionService,
                {
                    name: child.name,
                    slug: child.slug,
                },
                parent.collection.id,
            );
            summary.createdCollections += result.created ? 1 : 0;
            summary.updatedCollections += result.updated ? 1 : 0;
        }
    }

    for (const facetDefinition of CATALOG_FACETS) {
        const result = await upsertFacet(ctx, facetService, facetDefinition.code, facetDefinition.name);
        summary.createdFacets += result.created ? 1 : 0;
        summary.updatedFacets += result.updated ? 1 : 0;
    }

    await logOptionGroupTemplates(ctx, connection);

    return summary;
}

async function upsertCollection(
    ctx: RequestContext,
    collectionService: CollectionService,
    definition: { name: string; slug: string },
    parentId?: ID,
) {
    const existing = await collectionService.findOneBySlug(ctx, definition.slug);

    if (!existing) {
        const created = await collectionService.create(ctx, {
            filters: [],
            isPrivate: false,
            parentId,
            translations: getCollectionTranslations(definition.name, definition.slug),
        });
        return { collection: created, created: true, updated: false };
    }

    let updated = false;
    const translatedName = existing.name ?? '';
    if (translatedName !== definition.name) {
        await collectionService.update(ctx, {
            id: existing.id,
            translations: getCollectionTranslations(definition.name, definition.slug),
        });
        updated = true;
    }

    if (parentId) {
        const actualParent = await collectionService.getParent(ctx, existing.id);
        if (!actualParent || String(actualParent.id) !== String(parentId)) {
            const siblings = await collectionService.getChildren(ctx, parentId);
            await collectionService.move(ctx, {
                collectionId: existing.id,
                parentId,
                index: siblings.length,
            });
            updated = true;
        }
    }

    const resolved = (await collectionService.findOne(ctx, existing.id)) ?? existing;
    return { collection: resolved, created: false, updated };
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

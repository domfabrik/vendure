import { BundleExpectations, DescriptionStudyBundle, sha256Utf8 } from './description-study.bundle';

export const QA_EXPERIMENT = 'description-study-qa-20261005-v1';
export const QA_EXPECTATIONS: BundleExpectations = {
    experimentKey: QA_EXPERIMENT,
    sourceSnapshotSha256: 'c'.repeat(64),
    totalPublished: 12,
    selectedTotal: 4,
    oldEmptyTotal: 1,
};

const qaCase = (index: number, slug: string, oldText: string, newText: string) => {
    const sourceProductId = `qa-production-${index}`;
    const oldHash = sha256Utf8(oldText);
    const newHash = sha256Utf8(newText);
    return {
        sourceProductId,
        slug,
        productName: `QA Product ${index}`,
        imageUrl: index % 2 === 0 ? `https://example.invalid/${index}.jpg` : null,
        sourceUrl: `https://domfabrik.ru/products/${slug}`,
        sourceKind: 'CATALOG' as const,
        parsedCharacteristics:
            index === 1
                ? []
                : [{ name: `QA характеристика ${index}`, value: `Синтетическое значение ${index}` }],
        ordinal: index * 3,
        oldText,
        newText,
        oldHash,
        newHash,
        oldVersionId: `${QA_EXPERIMENT}:old:${sourceProductId}:${oldHash}`,
        newVersionId: `${QA_EXPERIMENT}:new:${sourceProductId}:${newHash}`,
        oldEmpty: oldText.length === 0,
        vendorName: 'QA vendor',
        productType: 'QA furniture',
        generationMetadata: { qaFixture: true, product: index },
    };
};

export const QA_BUNDLE: DescriptionStudyBundle = {
    schemaVersion: 1,
    experimentKey: QA_EXPERIMENT,
    title: 'Synthetic QA description study',
    sourceSnapshotSha256: QA_EXPECTATIONS.sourceSnapshotSha256,
    sourceCapturedAt: '2026-10-05T00:00:00.000Z',
    sourceOrigin: 'https://domfabrik.ru',
    selectionRule: 'Synthetic QA every-third cohort',
    totalPublished: QA_EXPECTATIONS.totalPublished,
    selectedTotal: QA_EXPECTATIONS.selectedTotal,
    generationComplete: true,
    cases: [
        qaCase(1, 'banketka-dzhokonda-krem-glyanec', '', 'New alpha description'),
        qaCase(2, 'banketka-gravita-seryj-kamen', 'Old beta description', 'New beta description'),
        qaCase(3, 'banketka-mokko-bezhevyj', 'Old gamma description', 'New gamma description'),
        qaCase(4, 'divan-afina-karavadzho', 'Old omega description', 'New omega description'),
    ],
};

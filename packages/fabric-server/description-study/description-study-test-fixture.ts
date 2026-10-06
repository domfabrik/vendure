import {
    BundleExpectations,
    canonicalJson,
    DescriptionStudyBundle,
    DescriptionStudyBundleV2,
    DescriptionStudyCase,
    sha256Utf8,
} from './description-study.bundle';

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

export const V2_QA_EXPERIMENT = 'description-study-qa-v2-20261005-v1';
export const V2_QA_EXPECTATIONS: BundleExpectations = {
    experimentKey: V2_QA_EXPERIMENT,
    sourceSnapshotSha256: 'd'.repeat(64),
    totalPublished: 9,
    selectedTotal: 3,
    oldEmptyTotal: 1,
};

const v2SourceCases = QA_BUNDLE.cases.slice(0, 2).map((source, index): DescriptionStudyCase => {
    const sourceProductId = `qa-v2-production-${index + 1}`;
    return {
        ...structuredClone(source),
        sourceProductId,
        oldVersionId: `${V2_QA_EXPERIMENT}:old:${sourceProductId}:${source.oldHash}`,
        newVersionId: `${V2_QA_EXPERIMENT}:new:${sourceProductId}:${source.newHash}`,
    };
});
const v2ExcludedSource = QA_BUNDLE.cases[2];
const v2Excluded = {
    sourceProductId: 'qa-v2-production-3',
    slug: v2ExcludedSource.slug,
    ordinal: v2ExcludedSource.ordinal,
    oldEmpty: v2ExcludedSource.oldEmpty,
    oldHash: v2ExcludedSource.oldHash,
    reason: 'Synthetic QA exclusion for persistence regression',
};
const v2ExclusionsSha256 = sha256Utf8(canonicalJson([v2Excluded]));
const v2Accounting = {
    selectedTotal: V2_QA_EXPECTATIONS.selectedTotal,
    includedTotal: 2,
    excludedTotal: 1,
    exclusionsSha256: v2ExclusionsSha256,
};
export const V2_QA_BUNDLE: DescriptionStudyBundleV2 = {
    schemaVersion: 2,
    experimentKey: V2_QA_EXPERIMENT,
    title: 'Synthetic QA v2 description study',
    sourceSnapshotSha256: V2_QA_EXPECTATIONS.sourceSnapshotSha256,
    sourceCapturedAt: '2026-10-05T00:00:00.000Z',
    sourceOrigin: 'https://domfabrik.ru',
    selectionRule: 'Synthetic QA every third cohort with explicit exclusions',
    totalPublished: V2_QA_EXPECTATIONS.totalPublished,
    selectedTotal: V2_QA_EXPECTATIONS.selectedTotal,
    processingComplete: true,
    includedTotal: v2Accounting.includedTotal,
    excludedTotal: v2Accounting.excludedTotal,
    excludedCases: [v2Excluded],
    exclusionsSha256: v2ExclusionsSha256,
    cases: v2SourceCases.map(source => ({
        ...source,
        generationMetadata: { ...source.generationMetadata, cohortAccounting: v2Accounting },
    })),
};

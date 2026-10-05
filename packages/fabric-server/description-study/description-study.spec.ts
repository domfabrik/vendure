/** Focused pure checks; the companion e2e runner owns all persistence assertions. */
/* eslint-disable no-console */
import assert from 'node:assert/strict';

import {
    BundleExpectations,
    DescriptionStudyBundle,
    sha256Utf8,
    validateDescriptionStudyBundle,
} from './description-study.bundle';
import { descriptionStudyEnabled, participantKey } from './description-study.service';

const experimentKey = 'description-study-qa-20261005-v1';
const expectations: BundleExpectations = {
    experimentKey,
    sourceSnapshotSha256: 'b'.repeat(64),
    totalPublished: 6,
    selectedTotal: 2,
    oldEmptyTotal: 1,
};
const version = (side: 'old' | 'new', productId: string, hash: string) =>
    `${experimentKey}:${side}:${productId}:${hash}`;
const makeCase = (index: number, slug: string, oldText: string, newText: string) => {
    const sourceProductId = `production-${index}`;
    const oldHash = sha256Utf8(oldText);
    const newHash = sha256Utf8(newText);
    return {
        sourceProductId,
        slug,
        productName: `Synthetic ${index}`,
        imageUrl: index === 1 ? null : 'https://example.invalid/image.jpg',
        sourceUrl:
            index === 1 ? `https://domfabrik.ru/products/${slug}` : `https://aridamebel.ru/catalog/${slug}`,
        sourceKind: index === 1 ? ('CATALOG' as const) : ('VENDOR' as const),
        parsedCharacteristics:
            index === 1 ? [] : [{ name: 'Материал', value: 'Массив дерева, подтверждено' }],
        ordinal: index * 3,
        oldText,
        newText,
        oldHash,
        newHash,
        oldVersionId: version('old', sourceProductId, oldHash),
        newVersionId: version('new', sourceProductId, newHash),
        oldEmpty: oldText.length === 0,
        vendorName: 'Synthetic vendor',
        productType: 'Synthetic type',
        generationMetadata: { fixture: true, index },
    };
};
const bundle: DescriptionStudyBundle = {
    schemaVersion: 1,
    experimentKey,
    title: 'Synthetic QA study',
    sourceSnapshotSha256: expectations.sourceSnapshotSha256,
    sourceCapturedAt: '2026-10-05T00:00:00.000Z',
    sourceOrigin: 'https://domfabrik.ru',
    selectionRule: 'Synthetic every third fixture',
    totalPublished: expectations.totalPublished,
    selectedTotal: expectations.selectedTotal,
    generationComplete: true,
    cases: [makeCase(1, 'alpha', '', 'New alpha'), makeCase(2, 'beta', 'Old beta', 'New beta')],
};

assert.equal(validateDescriptionStudyBundle(bundle, expectations), bundle);
const honestUnknowns = structuredClone(bundle);
honestUnknowns.cases[0].vendorName = '';
honestUnknowns.cases[1].productType = '';
assert.equal(validateDescriptionStudyBundle(honestUnknowns, expectations), honestUnknowns);
for (const publicUrl of [
    undefined,
    '',
    'https://domfabrik.ru',
    'https://other.invalid',
    'https://test.domfabrik.ru,http://localhost:3001',
    'prefix-https://test.domfabrik.ru',
]) {
    assert.equal(descriptionStudyEnabled(publicUrl), false, String(publicUrl));
}
assert.equal(descriptionStudyEnabled(' https://test.domfabrik.ru '), true);
assert.equal(participantKey(experimentKey, 42), participantKey(experimentKey, '42'));
assert.notEqual(participantKey(experimentKey, 42), participantKey(`${experimentKey}-other`, 42));

for (const mutate of [
    (copy: DescriptionStudyBundle) => (copy.cases[0].newText = 'tampered'),
    (copy: DescriptionStudyBundle) => (copy.cases[1].ordinal = 7),
    (copy: DescriptionStudyBundle) => (copy.cases[1].slug = 'aardvark'),
    (copy: DescriptionStudyBundle) => (copy.cases[0].oldEmpty = false),
    (copy: DescriptionStudyBundle) => (copy.cases[0].sourceProductId = copy.cases[1].sourceProductId),
    (copy: DescriptionStudyBundle) => (copy.cases[0].newVersionId = copy.cases[0].oldVersionId),
    (copy: DescriptionStudyBundle) =>
        (copy.cases[0].newVersionId = `${experimentKey}:old:${copy.cases[0].sourceProductId}:${copy.cases[0].newHash}`),
    (copy: DescriptionStudyBundle) => (copy.cases[0].sourceUrl = 'ftp://domfabrik.ru/products/alpha'),
    (copy: DescriptionStudyBundle) => (copy.cases[0].sourceUrl = 'https://user@domfabrik.ru/products/alpha'),
    (copy: DescriptionStudyBundle) => (copy.cases[0].sourceUrl = 'https://domfabrik.ru/products/wrong-slug'),
    (copy: DescriptionStudyBundle) => (copy.cases[0].sourceUrl = 'https://domfabrik.ru/products/alpha\n'),
    (copy: DescriptionStudyBundle) =>
        (copy.cases[0].sourceUrl = `https://domfabrik.ru/products/alpha${String.fromCharCode(0x85)}`),
    (copy: DescriptionStudyBundle) => (copy.cases[1].sourceUrl = 'https://example.invalid/beta'),
    (copy: DescriptionStudyBundle) =>
        ((copy.cases[0] as unknown as { sourceKind: string }).sourceKind = 'OTHER'),
    (copy: DescriptionStudyBundle) =>
        (copy.cases[0].parsedCharacteristics = Array.from({ length: 101 }, (_, index) => ({
            name: `Name ${index}`,
            value: `Value ${index}`,
        }))),
    (copy: DescriptionStudyBundle) => (copy.cases[0].parsedCharacteristics = [{ name: '', value: 'Value' }]),
    (copy: DescriptionStudyBundle) => (copy.cases[0].parsedCharacteristics = [{ name: 'Name', value: '' }]),
    (copy: DescriptionStudyBundle) =>
        (copy.cases[0].parsedCharacteristics = [{ name: 'N'.repeat(201), value: 'Value' }]),
    (copy: DescriptionStudyBundle) =>
        (copy.cases[0].parsedCharacteristics = [{ name: 'Name', value: 'V'.repeat(2001) }]),
    (copy: DescriptionStudyBundle) =>
        (copy.cases[0].parsedCharacteristics = [
            { name: 'Name', value: 'Value' },
            { name: 'Name', value: 'Value' },
        ]),
]) {
    const copy = structuredClone(bundle);
    mutate(copy);
    assert.throws(() => validateDescriptionStudyBundle(copy, expectations));
}

const incomplete = { ...structuredClone(bundle), generationComplete: false, cases: [] };
assert.equal(validateDescriptionStudyBundle(incomplete, expectations), incomplete);
assert.throws(() =>
    validateDescriptionStudyBundle({ ...structuredClone(bundle), generationComplete: false }, expectations),
);
console.log(
    'Description study unit checks passed: exact gate, hashes, frozen cohort and incomplete fixture rules',
);

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DESCRIPTION_STUDY_EXPERIMENT = 'description-third-20261005-v1';
export const DESCRIPTION_STUDY_SNAPSHOT_SHA =
    'a655ac3ba953723ec16f9881abd1eb15bda9dd20347f9952bf077afb34faa38c';

export type DescriptionSourceKind = 'VENDOR' | 'CATALOG';

export interface DescriptionCharacteristic {
    name: string;
    value: string;
}

export interface DescriptionStudyCase {
    sourceProductId: string;
    slug: string;
    productName: string;
    imageUrl: string | null;
    sourceUrl: string;
    sourceKind: DescriptionSourceKind;
    parsedCharacteristics: DescriptionCharacteristic[];
    ordinal: number;
    oldText: string;
    newText: string;
    oldHash: string;
    newHash: string;
    oldVersionId: string;
    newVersionId: string;
    oldEmpty: boolean;
    vendorName: string;
    productType: string;
    generationMetadata: Record<string, unknown>;
}

export interface DescriptionStudyBundle {
    schemaVersion: number;
    experimentKey: string;
    title: string;
    sourceSnapshotSha256: string;
    sourceCapturedAt: string;
    sourceOrigin: string;
    selectionRule: string;
    totalPublished: number;
    selectedTotal: number;
    generationComplete: boolean;
    cases: DescriptionStudyCase[];
}

export interface BundleExpectations {
    experimentKey: string;
    sourceSnapshotSha256: string;
    totalPublished: number;
    selectedTotal: number;
    oldEmptyTotal: number;
}

export const productionBundleExpectations: BundleExpectations = {
    experimentKey: DESCRIPTION_STUDY_EXPERIMENT,
    sourceSnapshotSha256: DESCRIPTION_STUDY_SNAPSHOT_SHA,
    totalPublished: 1537,
    selectedTotal: 512,
    oldEmptyTotal: 19,
};

export function sha256Utf8(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertString(value: unknown, field: string, allowEmpty = false): asserts value is string {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        throw new Error(`DESCRIPTION_STUDY_INVALID_BUNDLE:${field}`);
    }
}

function compareUnicodeCodePoints(left: string, right: string): number {
    const a = Array.from(left, character => character.codePointAt(0) as number);
    const b = Array.from(right, character => character.codePointAt(0) as number);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

const vendorSourceHosts = new Set([
    'era-mebel.com',
    'www.era-mebel.com',
    'aridamebel.ru',
    'www.aridamebel.ru',
    'fortunahome-mebel.ru',
    'www.fortunahome-mebel.ru',
    'fsm-matrasy.ru',
    'www.fsm-matrasy.ru',
    'merimebel.ru',
    'www.merimebel.ru',
    'nartmi.com',
    'www.nartmi.com',
]);

function validateSource(item: DescriptionStudyCase): void {
    assertString(item.sourceUrl, 'case.sourceUrl');
    if (item.sourceKind !== 'VENDOR' && item.sourceKind !== 'CATALOG')
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.sourceKind');
    if (/[\u0000-\u001f\u007f-\u009f]/.test(item.sourceUrl))
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.sourceUrl');
    let parsed: URL;
    try {
        parsed = new URL(item.sourceUrl);
    } catch {
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.sourceUrl');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.sourceUrl');
    if (item.sourceKind === 'CATALOG') {
        if (item.sourceUrl !== `https://domfabrik.ru/products/${item.slug}`)
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.sourceUrl');
    } else if (!vendorSourceHosts.has(parsed.hostname.toLowerCase())) {
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.sourceUrl');
    }
}

function validateCharacteristics(value: unknown): asserts value is DescriptionCharacteristic[] {
    if (!Array.isArray(value) || value.length > 100)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.parsedCharacteristics');
    const pairs = new Set<string>();
    for (const characteristic of value) {
        if (
            !characteristic ||
            typeof characteristic !== 'object' ||
            Array.isArray(characteristic) ||
            Object.keys(characteristic).sort().join(',') !== 'name,value'
        )
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.parsedCharacteristics');
        const { name, value: itemValue } = characteristic as DescriptionCharacteristic;
        if (
            typeof name !== 'string' ||
            name.length < 1 ||
            name.length > 200 ||
            typeof itemValue !== 'string' ||
            itemValue.length < 1 ||
            itemValue.length > 2000
        )
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.parsedCharacteristics');
        const identity = `${name}\u0000${itemValue}`;
        if (pairs.has(identity))
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.parsedCharacteristics');
        pairs.add(identity);
    }
}

export function validateDescriptionStudyBundle(
    value: unknown,
    expected: BundleExpectations = productionBundleExpectations,
): DescriptionStudyBundle {
    if (!value || typeof value !== 'object') throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:root');
    const bundle = value as DescriptionStudyBundle;
    if (bundle.schemaVersion !== 1) throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:schemaVersion');
    if (bundle.experimentKey !== expected.experimentKey)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:experimentKey');
    if (bundle.sourceSnapshotSha256 !== expected.sourceSnapshotSha256)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:sourceSnapshotSha256');
    if (bundle.sourceOrigin !== 'https://domfabrik.ru')
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:sourceOrigin');
    if (bundle.totalPublished !== expected.totalPublished || bundle.selectedTotal !== expected.selectedTotal)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:cohortSize');
    assertString(bundle.title, 'title');
    assertString(bundle.selectionRule, 'selectionRule');
    assertString(bundle.sourceCapturedAt, 'sourceCapturedAt');
    if (Number.isNaN(Date.parse(bundle.sourceCapturedAt)))
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:sourceCapturedAt');
    if (typeof bundle.generationComplete !== 'boolean' || !Array.isArray(bundle.cases))
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:cases');
    if (!bundle.generationComplete) {
        if (bundle.cases.length !== 0) throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:partial');
        return bundle;
    }
    if (bundle.cases.length !== expected.selectedTotal)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:caseCount');

    const productIds = new Set<string>();
    const slugs = new Set<string>();
    const versionIds = new Set<string>();
    let oldEmptyTotal = 0;
    let previousSlug: string | undefined;
    for (let index = 0; index < bundle.cases.length; index++) {
        const item = bundle.cases[index];
        if (!item || typeof item !== 'object') throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case');
        for (const field of [
            'sourceProductId',
            'slug',
            'productName',
            'oldText',
            'newText',
            'oldHash',
            'newHash',
            'oldVersionId',
            'newVersionId',
        ] as const) {
            assertString(item[field], `case.${field}`, field === 'oldText');
        }
        assertString(item.vendorName, 'case.vendorName', true);
        assertString(item.productType, 'case.productType', true);
        if (item.imageUrl !== null) assertString(item.imageUrl, 'case.imageUrl');
        validateSource(item);
        validateCharacteristics(item.parsedCharacteristics);
        if (
            !item.generationMetadata ||
            typeof item.generationMetadata !== 'object' ||
            Array.isArray(item.generationMetadata)
        )
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.generationMetadata');
        if (item.ordinal !== (index + 1) * 3)
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.ordinal');
        if (previousSlug !== undefined && compareUnicodeCodePoints(previousSlug, item.slug) >= 0)
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.slugOrder');
        previousSlug = item.slug;
        if (productIds.has(item.sourceProductId) || slugs.has(item.slug))
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.duplicateProduct');
        if (versionIds.has(item.oldVersionId) || versionIds.has(item.newVersionId))
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.duplicateVersion');
        productIds.add(item.sourceProductId);
        slugs.add(item.slug);
        versionIds.add(item.oldVersionId);
        versionIds.add(item.newVersionId);
        if (/\r/.test(item.oldText + item.newText))
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.lineEndings');
        if (item.newText.length === 0 || item.oldEmpty !== (item.oldText.length === 0))
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.empty');
        if (sha256Utf8(item.oldText) !== item.oldHash || sha256Utf8(item.newText) !== item.newHash)
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.hash');
        const expectedOldVersionId = `${bundle.experimentKey}:old:${item.sourceProductId}:${item.oldHash}`;
        const expectedNewVersionId = `${bundle.experimentKey}:new:${item.sourceProductId}:${item.newHash}`;
        if (
            item.oldVersionId === item.newVersionId ||
            item.oldVersionId !== expectedOldVersionId ||
            item.newVersionId !== expectedNewVersionId
        )
            throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:case.versionId');
        if (item.oldEmpty) oldEmptyTotal++;
    }
    if (oldEmptyTotal !== expected.oldEmptyTotal)
        throw new Error('DESCRIPTION_STUDY_INVALID_BUNDLE:oldEmptyTotal');
    return bundle;
}

export async function loadDescriptionStudyBundle(): Promise<DescriptionStudyBundle> {
    const filename = path.join(__dirname, 'data', 'candidates.v1.json');
    return validateDescriptionStudyBundle(JSON.parse(await readFile(filename, 'utf8')));
}

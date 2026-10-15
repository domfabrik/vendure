import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
    BundleExpectations,
    DescriptionStudyBundle,
    SOL_CREWAI_EXPERIMENT,
    SOL_CREWAI_QA_EXPERIMENT,
    validateDescriptionStudyBundle,
} from './description-study.bundle';

export const solCrewAiBundleExpectations: BundleExpectations = {
    experimentKey: SOL_CREWAI_EXPERIMENT,
    sourceSnapshotSha256: '0fe501a6aadec951cba7cfc1433ff647152d43ed5707835a2cbddbf1adb761c8',
    totalPublished: 1537,
    selectedTotal: 104,
    oldEmptyTotal: 0,
    newTextLineEndings: 'LF_OR_CRLF',
    casesSha256: '9219b140b641c8e9c0e582a0f27f50bbbd15e52b959bf50cea2fc6a2220e079a',
};

/** QA receives its own immutable dataset, ballots, progress and session namespace. */
export function createSolCrewAiQaBundle(bundle: DescriptionStudyBundle): DescriptionStudyBundle {
    return {
        ...structuredClone(bundle),
        experimentKey: SOL_CREWAI_QA_EXPERIMENT,
        cases: bundle.cases.map(item => ({
            ...structuredClone(item),
            oldVersionId: `${SOL_CREWAI_QA_EXPERIMENT}:old:${item.sourceProductId}:${item.oldHash}`,
            newVersionId: `${SOL_CREWAI_QA_EXPERIMENT}:new:${item.sourceProductId}:${item.newHash}`,
        })),
    };
}

export async function loadSolCrewAiBundle(): Promise<DescriptionStudyBundle> {
    const filename = path.join(__dirname, 'data', 'candidates.sol-crewai-104.v1.json');
    return validateDescriptionStudyBundle(
        JSON.parse(await readFile(filename, 'utf8')),
        solCrewAiBundleExpectations,
    );
}

export async function loadDescriptionStudyExperiments() {
    // Validate every profile before the bootstrap can write any of them.
    const current = await loadSolCrewAiBundle();
    const qa = createSolCrewAiQaBundle(current);
    const qaExpectations: BundleExpectations = {
        ...solCrewAiBundleExpectations,
        experimentKey: SOL_CREWAI_QA_EXPERIMENT,
        casesSha256: undefined, // Derived exclusively from the hash-pinned, validated main bundle above.
    };
    validateDescriptionStudyBundle(qa, qaExpectations);
    return [
        { bundle: current, expectations: solCrewAiBundleExpectations },
        { bundle: qa, expectations: qaExpectations },
    ];
}

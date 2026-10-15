import { INestApplication } from '@nestjs/common';
import { RequestContextService } from '@vendure/core';

import { loadDescriptionStudyExperiments } from './description-study.experiments';
import { descriptionStudyEnabled, DescriptionStudyService } from './description-study.service';

export async function synchronizeDescriptionStudy(app: INestApplication) {
    if (!descriptionStudyEnabled()) return { enabled: false, inserted: 0, existing: 0 };
    const contexts = app.get(RequestContextService);
    const ctx = await contexts.create({ apiType: 'admin' });
    const experiments = await loadDescriptionStudyExperiments();
    const results = [];
    for (const { bundle, expectations } of experiments) {
        const result = await app.get(DescriptionStudyService).syncBundle(ctx, bundle, expectations);
        results.push({ experimentKey: bundle.experimentKey, ...result });
    }
    return {
        enabled: true,
        inserted: results.reduce((total, result) => total + result.inserted, 0),
        existing: results.reduce((total, result) => total + result.existing, 0),
        experiments: results,
    };
}

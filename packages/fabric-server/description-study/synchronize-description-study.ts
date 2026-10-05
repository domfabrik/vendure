import { INestApplication } from '@nestjs/common';
import { RequestContextService } from '@vendure/core';

import { loadDescriptionStudyBundle } from './description-study.bundle';
import { descriptionStudyEnabled, DescriptionStudyService } from './description-study.service';

export async function synchronizeDescriptionStudy(app: INestApplication) {
    if (!descriptionStudyEnabled()) return { enabled: false, inserted: 0, existing: 0 };
    const contexts = app.get(RequestContextService);
    const ctx = await contexts.create({ apiType: 'admin' });
    const result = await app.get(DescriptionStudyService).syncBundle(ctx, await loadDescriptionStudyBundle());
    return { enabled: true, ...result };
}

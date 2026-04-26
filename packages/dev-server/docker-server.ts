import { bootstrap, JobQueueService } from '@vendure/core';

import { dockerConfig } from './docker-config';

bootstrap(dockerConfig)
    .then(async app => {
        if (process.env.RUN_JOB_QUEUE !== '0') {
            await app.get(JobQueueService).start();
        }
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });

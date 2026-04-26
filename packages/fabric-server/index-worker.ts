import { bootstrapWorker } from '@vendure/core';

import { fabricServerConfig } from './vendure-config';

const workerHealthPort = Number(process.env.VENDURE_WORKER_HEALTH_PORT ?? 3020);

bootstrapWorker(fabricServerConfig)
    .then(worker => worker.startJobQueue())
    .then(worker => {
        if (workerHealthPort <= 0) {
            return worker;
        }
        return worker.startHealthCheckServer({
            hostname: '0.0.0.0',
            port: workerHealthPort,
        });
    })
    .catch(err => {
        console.error(err);
        process.exit(1);
    });

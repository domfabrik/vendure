import { bootstrap } from '@vendure/core';

import { fabricServerConfig } from './vendure-config';

bootstrap(fabricServerConfig).catch(err => {
    console.error(err);
    process.exit(1);
});

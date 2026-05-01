import path from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

import { vendureDashboardPlugin } from '../../dashboard/vite/vite-plugin-vendure-dashboard.js';

export default defineConfig({
    base: '/admin-dashboard/',
    build: {
        outDir: path.resolve(__dirname, './dist'),
        emptyOutDir: true,
    },
    plugins: [
        vendureDashboardPlugin({
            vendureConfigPath: pathToFileURL(path.resolve(__dirname, '../vendure-config.ts')),
            api: {
                host: 'auto',
                port: 'auto',
            },
        }),
    ],
});

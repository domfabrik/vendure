ARG NODE_VER=20
FROM node:${NODE_VER}-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json lerna.json tsconfig.json tsconfig.docker-runtime.json ./
COPY packages/admin-ui/package.json ./packages/admin-ui/package.json
COPY packages/admin-ui-plugin/package.json ./packages/admin-ui-plugin/package.json
COPY packages/asset-server-plugin/package.json ./packages/asset-server-plugin/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/common/package.json ./packages/common/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/create/package.json ./packages/create/package.json
COPY packages/dashboard/package.json ./packages/dashboard/package.json
COPY packages/dev-server/package.json ./packages/dev-server/package.json
COPY packages/elasticsearch-plugin/package.json ./packages/elasticsearch-plugin/package.json
COPY packages/email-plugin/package.json ./packages/email-plugin/package.json
COPY packages/graphiql-plugin/package.json ./packages/graphiql-plugin/package.json
COPY packages/harden-plugin/package.json ./packages/harden-plugin/package.json
COPY packages/job-queue-plugin/package.json ./packages/job-queue-plugin/package.json
COPY packages/payments-plugin/package.json ./packages/payments-plugin/package.json
COPY packages/sentry-plugin/package.json ./packages/sentry-plugin/package.json
COPY packages/stellate-plugin/package.json ./packages/stellate-plugin/package.json
COPY packages/telemetry-plugin/package.json ./packages/telemetry-plugin/package.json
COPY packages/testing/package.json ./packages/testing/package.json
COPY packages/ui-devkit/package.json ./packages/ui-devkit/package.json

RUN npm ci
COPY packages ./packages
COPY docker-entrypoint.sh ./
RUN npm run build:core-common
RUN npx lerna run build --scope @vendure/asset-server-plugin
RUN npx lerna run build --scope @vendure/email-plugin
RUN npm run build:plugin --prefix packages/dashboard
RUN npx vite build --config packages/fabric-server/dashboard/vite.config.mts
RUN npx tsc -p tsconfig.docker-runtime.json
RUN mkdir -p .docker-runtime/packages/core/mock-data/data-sources .docker-runtime/packages/core/mock-data/assets
RUN cp packages/core/mock-data/data-sources/products.csv .docker-runtime/packages/core/mock-data/data-sources/products.csv
RUN cp -R packages/core/mock-data/assets/. .docker-runtime/packages/core/mock-data/assets/

FROM node:${NODE_VER}-bookworm-slim AS runtime

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/common ./packages/common
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/asset-server-plugin ./packages/asset-server-plugin
COPY --from=builder /app/packages/email-plugin ./packages/email-plugin
COPY --from=builder /app/packages/dashboard ./packages/dashboard
COPY --from=builder /app/packages/fabric-server ./packages/fabric-server
COPY --from=builder /app/.docker-runtime ./.docker-runtime
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

ENV NODE_ENV=production
ENV VENDURE_ROLE=server
EXPOSE 3000
EXPOSE 3020

RUN chmod +x docker-entrypoint.sh

CMD ["./docker-entrypoint.sh"]

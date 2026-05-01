ARG NODE_VER=20
FROM node:${NODE_VER}-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json lerna.json tsconfig.json tsconfig.docker-runtime.json ./
COPY packages ./packages
COPY docker-entrypoint.sh ./

RUN npm ci
RUN npm run build:core-common
RUN npx lerna run build --scope @vendure/asset-server-plugin
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

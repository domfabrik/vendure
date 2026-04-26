ARG NODE_VER=20
FROM node:${NODE_VER}-bookworm AS app

WORKDIR /app

COPY package.json package-lock.json lerna.json tsconfig.json ./
COPY packages ./packages
COPY docker-entrypoint.sh ./

RUN npm ci
RUN npm run build:core-common
RUN npx lerna run build --scope @vendure/asset-server-plugin

ENV NODE_ENV=production
ENV VENDURE_ROLE=server
EXPOSE 3000
EXPOSE 3020

RUN chmod +x docker-entrypoint.sh

CMD ["./docker-entrypoint.sh"]

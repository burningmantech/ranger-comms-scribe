# Comms Scribe backend: one Node process serving REST (/api/*), WebSocket
# upgrades (/api/ws/*) and GET /healthz on PORT (default 8080).
# Build context: backend/

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=8080
WORKDIR /app
# dist/server.js is a self-contained esbuild bundle, so no node_modules are
# copied. The only packages it leaves external are optional and not installed
# anyway: ws's native add-ons (bufferutil, utf-8-validate) and the AWS SDK's
# SigV4a signers (@aws-sdk/signature-v4-crt, @aws-sdk/signature-v4a), which
# are loaded in try/catch and only needed for multi-region access points.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

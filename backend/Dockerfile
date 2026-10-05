# Comms Scribe backend: one Node process serving REST (/api/*), WebSocket
# upgrades (/api/ws/*) and GET /healthz on PORT (default 8080).
# Build context: backend/

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=8080
WORKDIR /app
# dist/server.js is a self-contained esbuild bundle; the pruned production
# node_modules are kept for any optional native add-ons ws may load.
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

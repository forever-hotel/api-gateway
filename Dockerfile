# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=api-gateway-npm,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --prefer-offline
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=api-gateway-npm,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefer-offline
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

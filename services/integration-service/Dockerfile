FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/integration-service/tsconfig.json ./services/integration-service/
COPY services/integration-service/src ./services/integration-service/src/
RUN cd services/integration-service && npx tsc --build ../tsconfig.base.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/integration-service/dist ./dist
COPY package.json ./
RUN corepack enable && pnpm install --production --frozen-lockfile
EXPOSE 3005
CMD ["node", "dist/index.js"]

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/agent-orchestrator/tsconfig.json ./services/agent-orchestrator/
COPY services/agent-orchestrator/src ./services/agent-orchestrator/src/
RUN cd services/agent-orchestrator && npx tsc --build ../tsconfig.base.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/agent-orchestrator/dist ./dist
COPY package.json ./
RUN corepack enable && pnpm install --production --frozen-lockfile
EXPOSE 3006
CMD ["node", "dist/index.js"]

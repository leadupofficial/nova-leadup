FROM node:20-alpine AS builder

RUN apk add --no-cache libc6-compat openssl python3 make g++

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy workspace packages
COPY packages/shared-types ./packages/shared-types
COPY packages/database ./packages/database
COPY packages/auth ./packages/auth
COPY packages/voice ./packages/voice
COPY packages/ai-core ./packages/ai-core
COPY packages/tools ./packages/tools
COPY packages/memory ./packages/memory
COPY packages/policy ./packages/policy
COPY packages/observability ./packages/observability
COPY packages/ui ./packages/ui

RUN pnpm install --frozen-lockfile

# Build all services and packages
COPY services ./services
COPY packages ./packages
RUN pnpm run build

# ─── Production image ────────────────────────────────────────────────────────

FROM node:20-alpine

RUN apk add --no-cache libc6-compat openssl curl

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/auth/dist ./packages/auth/dist
COPY --from=builder /app/packages/voice/dist ./packages/voice/dist
COPY --from=builder /app/packages/ai-core/dist ./packages/ai-core/dist
COPY --from=builder /app/packages/tools/dist ./packages/tools/dist
COPY --from=builder /app/packages/memory/dist ./packages/memory/dist
COPY --from=builder /app/packages/policy/dist ./packages/policy/dist
COPY --from=builder /app/packages/observability/dist ./packages/observability/dist
COPY --from=builder /app/services/api/dist ./services/api/dist
COPY --from=builder /app/services/realtime-gateway/dist ./services/realtime-gateway/dist
COPY --from=builder /app/services/worker/dist ./services/worker/dist
COPY --from=builder /app/services/notification-service/dist ./services/notification-service/dist
COPY --from=builder /app/services/workflow-engine/dist ./services/workflow-engine/dist
COPY --from=builder /app/services/integration-service/dist ./services/integration-service/dist
COPY --from=builder /app/services/agent-orchestrator/dist ./services/agent-orchestrator/dist

# Copy package.json files for workspace resolution
COPY services/api/package.json ./services/api/package.json
COPY services/realtime-gateway/package.json ./services/realtime-gateway/package.json
COPY services/worker/package.json ./services/worker/package.json
COPY services/notification-service/package.json ./services/notification-service/package.json
COPY services/workflow-engine/package.json ./services/workflow-engine/package.json
COPY services/integration-service/package.json ./services/integration-service/package.json
COPY services/agent-orchestrator/package.json ./services/agent-orchestrator/package.json

EXPOSE 3000 3001 3002 3003 3004 3005

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
 CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "services/api/dist/server.js"]

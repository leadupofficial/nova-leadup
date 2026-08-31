FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache libc6-compat openssl python3 make g++

WORKDIR /app

# Copy root package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy workspace packages (needed for builds)
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

# Install all dependencies (including dev for build)
RUN pnpm install --frozen-lockfile

# Copy API source and build
COPY services/api ./services/api
RUN pnpm --filter @nova/api run build

# ─── Production image ────────────────────────────────────────────────────────

FROM node:20-alpine

RUN apk add --no-cache libc6-compat openssl curl

WORKDIR /app

# Copy only production artifacts
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
COPY services/api/package.json ./services/api/package.json

# Copy migration files if they exist
COPY services/api/migrations ./services/api/migrations 2>/dev/null || true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
 CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Entrypoint runs migrations then starts server
COPY deploy/api/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "services/api/dist/server.js"]

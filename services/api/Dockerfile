# NOVA API — production build for services/api
# This Dockerfile intentionally mirrors the structure used by docker-compose.prod.yml
# (which expects services/api/Dockerfile) and the root /Dockerfile. If the prod compose is used
# the build context is the repo root.
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Install workspace dependencies (cached layer)
COPY pnpm-workspace.yaml pnpm-lock.yaml turbo.json package.json ./
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/auth-types/package.json packages/auth-types/
COPY services/api/package.json services/api/

# Install everything required for the API. Falls back if the lockfile drifts.
RUN pnpm install --no-frozen-lockfile

# Build only the API
COPY packages/ packages/
COPY services/api/ services/api/
RUN cd services/api && pnpm run build

# Production runtime
FROM node:22-alpine AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base --chown=appuser:nodejs /app/services/api/dist ./dist
COPY --from=base --chown=appuser:nodejs /app/services/api/node_modules ./node_modules
COPY --from=base --chown=appuser:nodejs /app/services/api/package.json ./package.json
COPY --from=base --chown=appuser:nodejs /app/packages ./packages
USER appuser
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
 CMD node -e "require('http').get('http://localhost:3001/health/live', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"
CMD ["node", "dist/index.js"]

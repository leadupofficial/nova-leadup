# NOVA — Multi-service production build (pnpm monorepo)

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
COPY apps/web/package.json apps/web/
COPY services/api/package.json services/api/
COPY services/auth/package.json services/auth/
COPY services/workers/package.json services/workers/
COPY services/admin/package.json services/admin/
RUN pnpm install --frozen-lockfile

# Build all workspaces
COPY . .
RUN pnpm run build

# Production runtime
FROM node:22-alpine-slim AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 expressjs
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages ./packages
COPY --from=base /app/services ./services
COPY --from=base /app/apps ./apps
USER expressjs
EXPOSE 3001 3002 3003 3004
CMD ["node", "services/api/dist/index.js"]

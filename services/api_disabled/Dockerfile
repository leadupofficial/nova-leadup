# @nova/api — multi-stage production Dockerfile

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Install only production dependencies for this workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml turbo.json package.json ./
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --filter=@nova/api --prod

# Build
COPY . .
RUN pnpm run build --filter=@nova/api

# Production image
FROM node:22-alpine-slim AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 expressjs
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/services/api/dist ./dist
COPY services/api/package.json ./package.json
USER expressjs
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/index.js"]

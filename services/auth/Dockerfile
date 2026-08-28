# @nova/auth — multi-stage production Dockerfile

FROM node:22-alpine AS base
RUN apk add --no-cache python3 make g++ libc6-compat
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

# Install only production dependencies for this workspace
COPY pnpm-workspace.yaml pnpm-lock.yaml turbo.json package.json ./
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/utils/package.json packages/utils/
COPY packages/auth-types/package.json packages/auth-types/
COPY services/auth/package.json services/auth/
RUN pnpm install --frozen-lockfile --filter=@nova/auth --prod

# Build
COPY . .
RUN pnpm run build --filter=@nova/auth

# Production image
FROM node:22-alpine-slim AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 expressjs
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/services/auth/dist ./dist
COPY services/auth/package.json ./package.json
USER expressjs
EXPOSE 3003
CMD ["node", "dist/index.js"]

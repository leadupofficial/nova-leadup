FROM node:22-alpine
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY services/workflow-engine/package.json ./services/workflow-engine/package.json
COPY services/auth/package.json ./services/auth/package.json
RUN pnpm install --no-frozen-lockfile --prod
COPY services/workflow-engine/dist ./dist
COPY services/workflow-engine/package.json ./package.json
RUN addgroup -g 1001 -S nodejs && \
 adduser -S nodejs -u 1001 -G nodejs && \
 chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3010
# `dist/index.js` is the job-registry library: it has no event loop, so the container
# exited immediately and could never be healthy. The HTTP entry point is
# `src/server.ts` (health router, listens on PORT, default 3010).
CMD ["node", "dist/server.js"]

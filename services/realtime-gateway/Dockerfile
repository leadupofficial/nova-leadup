FROM node:22-alpine
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY services/realtime-gateway/package.json ./services/realtime-gateway/package.json
COPY services/auth/package.json ./services/auth/package.json
RUN pnpm install --no-frozen-lockfile --prod
COPY services/realtime-gateway/dist ./dist
COPY services/realtime-gateway/package.json ./package.json
RUN addgroup -g 1001 -S nodejs && \
 adduser -S nodejs -u 1001 -G nodejs && \
 chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3002
CMD ["node", "dist/server.js"]

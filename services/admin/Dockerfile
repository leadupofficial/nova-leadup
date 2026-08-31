FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/admin/tsconfig.json ./services/admin/
COPY services/admin/src ./services/admin/src/
RUN cd services/admin && npx tsc --build ../tsconfig.base.json

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/services/admin/dist ./dist
COPY package.json ./
RUN corepack enable && pnpm install --production --frozen-lockfile
EXPOSE 3004
CMD ["node", "dist/index.js"]

# NOVA API — production image for services/api.
#
# Build (context is the repo root):
#   docker build -f services/api/Dockerfile -t nova-api:prod .
#
# Three things here were wrong before this file was rewritten, and each one is a deploy that
# fails at the build step rather than in production:
#
#  1. `CMD ["node", "dist/index.js"]` — services/api has no src/index.ts. The entry is
#     src/server.ts and `pnpm run build` emits dist/server.js, so the container started and
#     exited immediately with "Cannot find module '/app/dist/index.js'". docker-compose's
#     `restart: unless-stopped` then turned that into a crash loop.
#
#  2. The dependency layer copied only `packages/{config,types,utils,auth-types}/package.json`,
#     which is not this workspace's dependency graph. services/api imports @nova/database and
#     @nova/shared-types, so with those manifests absent `pnpm install` fails with
#     ERR_PNPM_WORKSPACE_PKG_NOT_FOUND before it builds anything.
#
#  3. It built the API alone (`cd services/api && pnpm run build`). tsc resolves @nova/database
#     through its package `exports`, which point at `dist/` — and `dist/` is gitignored, so a
#     clean build context has no database types and the API build fails with TS2307. Turbo's
#     `dependsOn: ["^build"]` is what makes the order correct: it compiles every workspace
#     package the API depends on *before* compiling the API.
#
# An earlier deploy hid (3) by shipping a developer's prebuilt dist/. The build below is
# reproducible from a context that contains no dist/ at all.

FROM node:22-alpine AS base
# python3/make/g++ are required by node-gyp: the workspace pulls in better-sqlite3, whose
# install script compiles a native binding. Without them `pnpm install` aborts with
# "gyp ERR! stack Error: Could not find any Python installation to use" and the image never
# builds. The runtime stage below deliberately does not carry any of this — the compiled
# binding is copied with node_modules, and a production image has no business shipping a
# toolchain.
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Manifests first so the dependency layer caches independently of source edits. The workspace
# is `apps/*` + `services/*` + `packages/*`, so pnpm needs every member's package.json to
# resolve `workspace:*` specifiers; apps/mobile is deliberately absent (12 GB of Flutter build
# output that the API never reads, and .dockerignore removes it from the context anyway).
COPY pnpm-workspace.yaml pnpm-lock.yaml turbo.json package.json tsconfig.json tsconfig.base.json .npmrc ./
COPY packages/ ./packages/
COPY services/ ./services/
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/web/package.json ./apps/web/package.json

# --no-frozen-lockfile: the lockfile is generated on macOS and records optional platform
# packages that do not resolve on Alpine; a frozen install fails on those instead of installing
# the Linux equivalents.
RUN pnpm install --no-frozen-lockfile

# Only the three packages the API actually imports, in dependency order.
#
# `turbo run build --filter=@nova/api` is the obvious choice here and it does not work: it
# builds the *declared* dependency closure, and services/api/package.json declares
# `@nova/auth: workspace:*` (services/auth) which the API stopped importing when auth moved
# into services/api/src/routes/auth.ts. That stale manifest entry makes turbo compile
# services/auth, which fails on pre-existing errors of its own — TS5083 (its tsconfig extends a
# root tsconfig.json that is not in this context), TS2307 for @nova/utils, and a batch of
# default-import errors. Those are real defects in a service this image does not run, and
# letting them fail the API's deploy would mean fixing an unrelated service first.
#
# The import set below is not aspirational: `grep -rhoE "@nova/[a-z-]+" services/api/src` returns
# @nova/database and @nova/shared-types and nothing else. If the API starts importing another
# workspace package, this line has to change with it — which is why it is spelled out instead of
# hidden behind a filter that would silently keep working.
RUN pnpm --filter @nova/shared-types build \
 && pnpm --filter @nova/database build \
 && pnpm --filter @nova/api build

FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 appuser
WORKDIR /app
ENV NODE_ENV=production

# The database runs in Etc/UTC and every `timestamp` column here is *without* time zone, so the
# value a driver writes is a bare wall-clock string. Two drivers write these columns — Drizzle
# serialises a Date as UTC, node-postgres serialises it in the process timezone — and on read,
# node-postgres interprets a bare timestamp in the process timezone. If the process is not UTC
# those two disagree by the offset. Pinning the process to UTC makes every writer and reader
# agree with the database, which is what stops `admin_sessions.expires_at` from reading hours
# in the past on a host set to IST.
ENV TZ=UTC

# The workspace layout is preserved rather than flattened: services/api/node_modules holds
# pnpm symlinks into the root store and into ../../packages, so copying the app directory
# without both of those produces dangling links that Node reports as MODULE_NOT_FOUND.
COPY --from=base --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=base --chown=appuser:nodejs /app/packages ./packages
COPY --from=base --chown=appuser:nodejs /app/services ./services
COPY --from=base --chown=appuser:nodejs /app/apps ./apps
COPY --from=base --chown=appuser:nodejs /app/package.json ./package.json

USER appuser
EXPOSE 3001

# `curl` does not exist in the node:22-alpine runtime image, so the probe uses Node's global
# fetch rather than adding an HTTP client to the image just for a healthcheck.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
 CMD node -e "fetch('http://localhost:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/dist/server.js"]

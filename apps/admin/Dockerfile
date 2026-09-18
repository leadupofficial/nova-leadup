# NOVA admin console — apps/admin (Next.js 15, App Router).
#
# Build:
#   docker build -f apps/admin/Dockerfile -t nova-admin-ui:latest .
#
# Unlike services/Dockerfile.multi (which copies a prebuilt dist/), this image
# compiles from source. That is deliberate: `output: "standalone"` tracing is
# incomplete against pnpm's symlinked node_modules here (it omits
# next/dist/server/lib/cpu-profile), so the runtime needs a real install.
#
# Only nova-admin and the workspace package it consumes are installed, so the
# image does not pull in the whole monorepo toolchain.

FROM node:22-alpine AS build
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# tsconfig.base.json is required: apps/admin/tsconfig.json extends it, and
# `next build` fails with "Cannot read file '/app/tsconfig.base.json'" without it.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared-types ./packages/shared-types
COPY apps/admin ./apps/admin

RUN pnpm install --no-frozen-lockfile --filter nova-admin...

# @nova/shared-types MUST be compiled before the console.
#
# apps/admin/src/app/languages/page.tsx imports it, and its package.json resolves
# through ./dist — which is gitignored (`.gitignore: dist/`), so it is absent from
# a clean checkout. Relying on a developer's stale local dist made this image
# buildable only from this working tree; a pristine `git archive HEAD` context
# failed with "Module not found: Can't resolve '@nova/shared-types'".
RUN pnpm --filter @nova/shared-types build

# Next inlines NEXT_PUBLIC_* at build time, so the public API base is baked in here.
ARG NEXT_PUBLIC_API_BASE=https://nova.leadup.in/api/v1
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter nova-admin build

FROM node:22-alpine AS admin-ui-final
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3005 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    # Server-side rendering talks to the sibling containers directly instead of
    # hairpinning out through the public hostname. `api` and `admin` are the
    # docker-compose service names on nova-network.
    API_INTERNAL_URL=http://api:3001/api/v1 \
    API_ORIGIN_URL=http://admin:3004

# Keep the workspace layout identical to the build stage so pnpm's relative
# node_modules symlinks (e.g. apps/admin/node_modules/@nova/shared-types ->
# ../../../../packages/shared-types) still resolve.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=build /app/apps/admin/.next ./apps/admin/.next
COPY --from=build /app/apps/admin/package.json ./apps/admin/package.json
COPY --from=build /app/apps/admin/next.config.js ./apps/admin/next.config.js

RUN addgroup --system app && adduser --system app && chown -R app:app /app
USER app
WORKDIR /app/apps/admin
EXPOSE 3005
CMD ["node_modules/.bin/next", "start", "-p", "3005", "-H", "0.0.0.0"]

# syntax=docker/dockerfile:1.7
# AI ME images (docs/deployment.md). One build stage, one target per service:
#   api, worker (headless until M8), migrate (prisma migrate deploy + seed), web (Caddy with the built web app).
# Build context: the repository root (./docker/aime up).

# Same Node as CI (.nvmrc).
ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
# prisma generate reads DATABASE_URL from prisma.config.ts; nothing connects during the build.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm turbo run build --env-mode=loose --filter=@ai-me/api --filter=@ai-me/worker --filter=@ai-me/web
# Production node_modules only, workspace packages copied in (their dist).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @ai-me/api deploy --legacy --prod /out/api && \
    pnpm --filter @ai-me/worker deploy --legacy --prod /out/worker

FROM base AS api
WORKDIR /app
COPY --from=build --chown=node:node /out/api .
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM base AS worker
WORKDIR /app
COPY --from=build --chown=node:node /out/worker .
# The browser stack (README §6): Playwright's Chromium with its system libraries, a virtual display (Xvfb + fluxbox),
# and the live view (x11vnc on localhost, websockify on 6080 for noVNC). DejaVu for Cyrillic pages.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright/cli.js install --with-deps chromium && \
    apt-get update && apt-get install -y --no-install-recommends xvfb fluxbox x11vnc websockify fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=755 docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
# HOME on the tmpfs: fluxbox and Chromium write there; the image itself is read-only.
ENV NODE_ENV=production DISPLAY=:99 HOME=/tmp ARTIFACTS_DIR=/data/artifacts
USER node
EXPOSE 6080
CMD ["worker-entrypoint"]

# The full workspace: the prisma CLI and the seed are dev tools.
FROM build AS migrate
# The prisma CLI's schema engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/packages/db
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec prisma db seed"]

FROM caddy:2.10-alpine AS web
# Caddy listens on 8080 inside, so the binary's cap_net_bind_service is dropped: it runs with no capabilities at all.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv

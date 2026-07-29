# Worker image.
#
# Containerized deliberately: the same image runs on a VM with Docker, on
# Kubernetes, or beside a managed web tier, so the hosting decision stays open
# (docs/test-center-plan.md §1b). The worker is long-running because streaming a
# multi-hundred-megabyte report through a SAX parser is the workload short-lived
# serverless invocations handle worst.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
# Copy manifests first so dependency installation caches independently of source.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/adapters/package.json packages/adapters/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @testcenter/worker...

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm --filter @testcenter/worker... build
# Drop dev dependencies from the layer we ship.
RUN pnpm --filter @testcenter/worker... --prod deploy /out

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
# SQL migrations travel with the image so a deploy can apply its own schema.
COPY --from=build /repo/packages/db/sql ./node_modules/@testcenter/db/sql

# Unprivileged: the worker only needs outbound Postgres/Redis/object storage.
USER node

# SIGTERM is handled in src/index.ts to drain in-flight jobs; a job killed midway
# through persisting results would leave a half-written run.
STOPSIGNAL SIGTERM

CMD ["node", "dist/src/index.js"]

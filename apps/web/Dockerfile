# syntax=docker/dockerfile:1
# =============================================================================
# apps/web — the employee-facing application.
#
# Telemetry is disabled HERE, in the image that actually runs, and in CI. Not in
# a local .env: docs/06-technology-decisions.md §Telemetry kill list is explicit
# that a switch set on a developer's laptop protects nobody, and a dependency
# that phones home from inside an HRMS deployment is a review finding.
# =============================================================================
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    CI=1
RUN corepack enable
WORKDIR /repo

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json  packages/core/package.json
COPY packages/ai/package.json    packages/ai/package.json
COPY packages/db/package.json    packages/db/package.json
COPY apps/web/package.json       apps/web/package.json
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
# `prebuild` runs the route manifest check. A route that does not declare who
# may reach it fails the IMAGE BUILD, so it can never reach a running server.
RUN pnpm --filter @hrms/web build

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Never root. The application has no reason to write anywhere but its own tmp.
RUN useradd --system --uid 10001 --create-home hrms
WORKDIR /repo
COPY --from=build --chown=hrms:hrms /repo /repo
USER hrms
EXPOSE 3000

# `prestart` runs the manifest check again at container start. The build-time
# check protects the image; this one protects against anything mounted, patched
# or hot-fixed into a running container.
CMD ["pnpm", "--filter", "@hrms/web", "start"]

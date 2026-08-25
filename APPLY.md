# Applying this work to surbhigoyal7381-agent/hrms-ai

Two ways. **The bundle keeps the commits and their messages** — prefer it.

## Option A — git bundle (recommended)

```bash
cd /path/to/hrms-ai
git bundle verify /path/to/core-hr-foundation.bundle
git fetch /path/to/core-hr-foundation.bundle feat/core-hr-foundation:feat/core-hr-foundation
git switch feat/core-hr-foundation
```

Then review and merge, or open a PR:

```bash
git push -u origin feat/core-hr-foundation
gh pr create --fill
```

## Option B — patch file

```bash
cd /path/to/hrms-ai
git switch -c feat/core-hr-foundation
git am /path/to/core-hr-foundation.patch
```

## Running it

Postgres 16 with the `pgcrypto`, `btree_gist` and `citext` extensions available.
The official `postgres:16` image has all three. Use **port 5433**, the same port
CI uses — 5432 is usually taken by a locally installed Postgres, and a version
other than 16 is not what CI tests against.

```bash
docker run -d --name hrmspg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=hrms -p 5433:5432 postgres:16

pnpm install                      # once, at the repo root — commit pnpm-lock.yaml
cp .env.example .env              # fill in DATABASE_URL
pnpm db:migrate

# The tests do NOT read DATABASE_URL. test/setup.ts creates a database per
# suite, so it needs libpq variables and psql on PATH — set both before running.
export PGHOST=localhost PGPORT=5433   # same as CI
export PATH="$PATH:/path/to/postgresql/bin"   # setup.ts shells out to psql

cd packages/core && npx vitest run
cd ../ai && npx vitest run
```

Expect **88 passing tests** — 71 in `packages/core`, 17 in `packages/ai`.

The integration tests connect as `hrms_app`, the non-owner application role. If
they connect as a superuser they will pass while proving nothing, because
superusers bypass row-level security entirely.

## Read first

- `docs/features/001-core-hr-foundation/50-review.md` — what two review rounds found
- `docs/features/001-core-hr-foundation/99-decision-log.md` — why the schema is shaped this way
- `docs/06-technology-decisions.md` §Telemetry kill list — set these in your Dockerfile

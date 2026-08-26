---
feature: 001-core-hr-foundation
artefact: design-notes
author: hrms-fullstack-engineer
date: 2026-08-24
status: draft
inputs: [10-opportunity.md, 20-requirements.md]
---

# Design notes — Core HR foundation

**Tier: L (System).** New module, new data model, and it touches the one-way doors. Full process.

## What I am building

The temporal, multi-tenant data foundation every other module will stand on: people, employments, effective-dated employment attributes, an org tree, positions, and the four platform tables (audit, transparency ledger, data classification, analytics events) that make the compliance and transparency promises real rather than documented.

Requirements covered: REQ-001 … REQ-010, RULE-001 … RULE-003.

## Architecture shape

**One deployable.** A Next.js app whose route handlers are a thin transport layer over `packages/core`, which is **framework-free** — no Next imports, no HTTP types, pure functions over a database connection.

That boundary is the whole design decision. It costs almost nothing today and means extracting a standalone API service later (for mobile, integrations, webhooks) is a mechanical move rather than a rewrite. **Extraction trigger:** the first external integration that needs an authenticated API we do not control the client for.

```
apps/web            Next.js — transport, auth session, UI
packages/core       domain logic: temporal queries, change operations, policy
packages/db         Drizzle schema + SQL migrations (SQL is authoritative)
packages/ai         the model gateway — empty in this module, no AI here
```

**Migrations are hand-written SQL, not generated.** RLS policies, exclusion constraints and role grants are the security model; they must be reviewable line by line in a diff, and a generated migration hides exactly the lines that matter most.

## Tenant isolation — the highest-consequence decision

Shared schema, `tenant_id` on every tenant-scoped table, enforced by Postgres Row-Level Security.

Three things make this actually safe rather than nominally safe:

**1. `FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** `ENABLE` does not apply to the role that owns the table — and application connections very commonly run as the owner. This is the single most common multi-tenant leak in this architecture. Every tenant-scoped table gets `FORCE`.

**2. The tenant comes from the session, not from the query.** The app sets `app.tenant_id` with `set_config(..., true)` (transaction-local) at the start of every request transaction. Policies read `current_setting('app.tenant_id', true)`. **Application code never writes `WHERE tenant_id = ?`** — if it did, forgetting it once would be the breach. With this design, forgetting it returns zero rows instead of someone else's rows.

**3. `app.tenant_id` unset means zero rows, never all rows.** The policy is written so a missing setting fails closed. A bug that drops the session variable degrades to an empty screen, not a data leak.

The application connects as a non-owner role (`hrms_app`) that has DML but no DDL, cannot bypass RLS, and has `UPDATE`/`DELETE` revoked on `audit_log`.

## The temporal model

Append-only versions with business time (`valid_from`, `valid_to`) and system time (`recorded_at`). Never UPDATE a version's business data; never DELETE.

**Non-overlap is enforced by the database**, not by application code:

```sql
EXCLUDE USING gist (
  employment_id WITH =,
  daterange(valid_from, valid_to, '[)') WITH &&
)
```

Empty ranges (where `valid_from = valid_to`, produced by a retroactive supersede) do not participate in `&&`, which is exactly the behaviour RULE-001 needs. A concurrency bug that would create two overlapping versions now fails as a constraint violation rather than silently double-counting Aisha in two org units — and the point-in-time query returning two rows for one person is precisely the bug that corrupts every headcount downstream.

`btree_gist` is required for this and is a standard contrib extension.

## API contract (route handlers over `packages/core`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/employees` | HR | Idempotency-Key header required |
| GET | `/api/employees?asOf=YYYY-MM-DD` | any authenticated | field-filtered by policy |
| GET | `/api/employees/{id}` | policy | 404 (not 403) across tenants — 403 confirms existence |
| POST | `/api/employees/{id}/changes` | manager/HR | effective-dated change; `reason` required |
| PATCH | `/api/employees/{id}/self` | self | allowlist-enforced server-side |
| GET | `/api/employees/{id}/history` | self/mgr/HR | the transparency ledger |
| GET | `/api/me/export` | self | `COMP-21` |
| GET | `/api/org-units?asOf=` | any authenticated | tree |

Error shape is uniform: `{ error: { code, message, fields? } }`. `422` carries field-level detail; `409` on optimistic-concurrency conflict states what changed.

## Failure matrix

| What fails | Detected | Behaviour | User sees |
|---|---|---|---|
| Notification service | timeout 3s | change commits; notification enqueued in pg-boss, retried 5× backoff | "Saved. Aisha will be notified shortly." |
| `app.tenant_id` not set | RLS returns zero rows | request fails closed with 500 and a loud alert | generic error; **never another tenant's data** |
| Overlapping version (race) | exclusion constraint violation | 409, no partial write | "Someone else just changed this. Here's what changed." |
| Reporting cycle introduced | recursive check at write time | 422 naming the cycle path | "That would make A report to B and B report to A." |
| Bulk import row invalid | per-row validation | valid rows commit, invalid reported with row + column | downloadable error report |
| Postgres unavailable | connection error | 503, no retry storm | "We can't reach your data right now." |

## NFR plan

| NFR | Target | How this design meets it | Verified by |
|---|---|---|---|
| `SEC-02` | zero cross-tenant rows | `FORCE RLS` + session tenant + fail-closed policy | integration test, two tenants, every table |
| `SEC-05` | immutable audit | `UPDATE`/`DELETE` revoked from `hrms_app` at the role level | test asserts both fail |
| `REL-03` | idempotent writes | `Idempotency-Key` + unique index | double-submit test |
| `REL-07` | history preserved | append-only versions; no destructive update path exists | retroactive-change test |
| `REL-08` | business dates | `date` columns, half-open intervals, no timestamps in the temporal key | boundary tests incl. 29 Feb |
| `PERF-03` | org chart < 1.5s @ 50k | recursive CTE + covering index; virtualised UI | load test (deferred to gate 4) |
| `COMP-01` | classification metadata | `data_classification` populated by migration; CI check | CI fails on an unclassified personal-data column |
| `COMP-34` | no unclassified field | same | same |

## Alternatives rejected

**Schema-per-tenant.** Genuinely stronger isolation, and I considered it seriously. Rejected because migrating 5,000 schemas on every release is an operational burden that will dominate engineering time, and `FORCE RLS` with a fail-closed policy plus a cross-tenant test suite gets most of the safety. **Revisit only for a customer with a contractual physical-isolation requirement** — and note that changing later is a migration, not a refactor.

**A generic EAV custom-field table from day one.** Rejected per the PM's non-goals. It makes every query slower and every migration harder, in exchange for flexibility nobody has asked for yet.

**Storing a `vacancy_count` on `position`.** Rejected — derived values drift. Vacancy is computed from headcount minus filled assignments on the as-of date.

**Generated migrations.** Rejected. The security model lives in the migration; it must be reviewable.

## One-way doors touched

All six from `CLAUDE.md` §7. Multi-tenancy (shared schema + FORCE RLS), time model (business dates, half-open intervals), effective-dating (append-only), classification metadata (from table one). Money is not touched in this module. Residency is deployment configuration, not schema. **Recorded in `99-decision-log.md`; PM sign-off needed on the shared-schema choice.**

## Migration and rollback

Forward: one migration creating extensions, tables, indexes, constraints, RLS policies, roles and grants, plus the `data_classification` seed. Rollback: a down migration dropping in reverse dependency order. **On a database with real tenant data, rollback is not a drop** — it is a forward-fix migration, and the runbook says so explicitly.

## Simplicity check (Gate 0)

1. **What does the complexity buy?** Effective dating buys correct payroll for mid-period changes, defensible historical headcount, and retroactive corrections that produce arrears rather than silently rewriting history. RLS buys tenant isolation that survives a developer forgetting a `WHERE` clause. Both are bought.
2. **Simplest 80% version?** A flat table with `manager_id`. It delivers the demo and none of the correctness. Explicitly rejected — see the requirements.
3. **Aisha's main action in 10s?** Viewing her record: target < 2s to interactive. Self-correction: < 10s.
4. **Left out:** custom fields, approval workflows, multi-entity, matrix org, headcount planning, delegation for managers on leave.

## Amendment, 2026-08-26 — who `actor_id` refers to (defect fix on shipped code)

This note originally described `actor_id` and `decided_by` only as "who did it". It never said
**which kind of id** they hold, and neither did the schema: they were plain `uuid` with no
foreign key, while `transparency_ledger.subject_employment_id` next to them was
`NOT NULL REFERENCES employment(id)`. The subject of a decision was constrained; the decider
was not. Erasure searched those columns by joining to `employment`, the application wrote a
login account id into them, and the two never met — so erasure silently erased nothing in
three of the six stores. Full reasoning, evidence and rejected alternatives are in
`99-decision-log.md` under the same date.

**As built now:**

| Concern | Decision |
|---|---|
| Referent | `actor_id` / `decided_by` are always an `employment.id`. |
| Schema enforcement | Migration `0002` adds `(tenant_id, <column>) REFERENCES employment (tenant_id, id)` to `audit_log.actor_id`, `analytics_event.actor_id`, `transparency_ledger.decided_by`, `employment_version.decided_by`, `org_unit_version.decided_by`, `legal_hold.placed_by`, `legal_hold.released_by`. Composite, because FK checks bypass RLS and a single-column key accepts another tenant's employment. |
| Type enforcement | `Principal` carries ONE identity, `actorEmploymentId: EmploymentId`, non-null and branded. `Actor` **is** the `Principal`, not a value assembled next to it. |
| Nullability | `NULL` stays legal on `audit_log.actor_id` and `analytics_event.actor_id`. A composite FK is MATCH SIMPLE, so the rule reads "NULL, or a real employment in this tenant" — which is what COMP-22 needs against COMP-53's append-only grant. |
| Actors with no employment | Cannot act on employment records. Deliberate. A future import or purge job gets its own modelled identity, not a nullable column. |

**Failure matrix addition**

| What fails | Detected how | Behaviour | User sees |
|---|---|---|---|
| Caller supplies an id that is not an employment | Composite FK, at write time | Whole transaction rolls back; the change, its audit row and its ledger entry all fail together | An error, not a half-written change — the ledger entry and the change it explains are already in one transaction by design |
| Caller supplies another tenant's employment | Tenant component of the same FK | Same | Same |
| Person who acted requests erasure | `erasePerson` | Actor link NULLed on `audit_log` and `analytics_event`; `decided_by_name` pseudonymised on the ledger, which stays append-only so other people's evidence survives | "Former employee" in place of the name |
| The erasing actor IS the person being erased | `erasePerson` checks before writing its own audit row | That row records a NULL actor and flags `selfService`; it no longer re-links the person into a store just cleared | Nothing — `resource_id` still identifies whose erasure it was |

**Migration and rollback for 0002.** Adds constraints and indexes only — no column added, dropped
or retyped, and no row rewritten, so the down path (written out in the migration file) loses no
data. Rolling back re-opens the erasure gap. The migration refuses to run against a database
that already holds a bad actor id, and names the table, column and row count rather than leaving
Postgres' own constraint error to be decoded.

**Two gates that were not gates.** `tsc` had never run on this repo — no `typecheck` script and
no `@types/node`, and `vitest` strips types without checking them — so the branded type above
would have been decorative. And both the test harness and the classification CI job applied
`0001_core_hr_foundation.sql` **by name**, so no later migration was ever exercised or checked.
Both fixed: typecheck runs in `pnpm test` and as its own CI step, and both paths now apply every
migration in sorted order.

## Handoff

**To:** hrms-test-automation
**Ready:** yes
**Write your test plan from `20-requirements.md` before reading my implementation.**
**Challenge these:** shared schema over schema-per-tenant · non-overlap enforced in the database rather than the application · legal name corrected in place rather than effective-dated · `exited` as a terminal state.

**Added 2026-08-26, for the Test Automation agent.** The rule the suite must now hold to:
**an assertion must not use the same predicate, constant or derivation as the code it tests.**
Three erasure assertions and the `decided_by` accountability assertion were tautologies that
passed against broken code. Assert against something independently known — the identifier you
seeded, a count taken before the action, a row you inserted deliberately — and put a
`toBeGreaterThan(0)` guard before any "and now it is zero" check, so a vacuous pass fails loudly.
A sweep of the whole suite found further instances of the same shape that are **not** fixed here
and need a test-plan decision: the point-in-time predicate re-implemented inside
`employment.test.ts` rather than exercised through `POINT_IN_TIME_PREDICATE`; the PRIV-07
"no PII in audit payloads" check, which searches for a string that no code path can put in that
table; the RLS cross-tenant sweep, whose per-row loop asserts nothing for the tables that are
empty; and in `packages/ai`, `it.each` cases generated from the very set they are meant to
police.

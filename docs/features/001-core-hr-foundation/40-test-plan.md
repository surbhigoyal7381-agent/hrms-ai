---
feature: 001-core-hr-foundation
artefact: test-plan
author: hrms-test-automation
date: 2026-08-24
status: draft
inputs: [20-requirements.md]
---

# Test plan — Core HR foundation

Written from `20-requirements.md` **before** reading the implementation. Where a requirement was untestable as written, that is recorded as a finding rather than resolved by guessing.

## How these run

Integration tests connect as **`hrms_app`** — the non-owner, `NOBYPASSRLS` application role — never as `postgres`. Testing RLS as a superuser proves nothing: superusers bypass it entirely, and a suite that does this passes every assertion while the product leaks.

```bash
cd packages/core && PGHOST=<socket> PGPORT=<port> npx vitest run
```

`fileParallelism` is off: the integration files create and drop databases and would otherwise fight over names.

## Traceability

| Req / Rule | What must be true | Tier | Test | Status |
|---|---|---|---|---|
| REQ-001 | No cross-tenant row from any table | integration | `rls.test.ts` — catalogue sweep, reads + writes | ✅ |
| REQ-001 | Unset tenant → zero rows, never all rows | integration | `fail-closed` block, incl. empty string | ✅ |
| REQ-001 | RLS **forced**, app role cannot bypass | integration | `relforcerowsecurity`, `rolbypassrls` | ✅ |
| REQ-001 | Tenant registry itself is scoped | integration | `cannot see tenant B in the registry` | ✅ |
| REQ-002 | Create an employee | — | — | ❌ **not implemented** |
| REQ-003 | Effective-dated change closes + appends | integration | `the transfer … produces the exact table` | ✅ |
| REQ-003 | Reason required, non-empty after trim | integration | `refuses a change with an empty reason` | ✅ |
| REQ-003 | Effective date ≥ hire date | integration | `refuses an effective date before the hire date` | ✅ |
| REQ-003 | Non-manager gets refused | integration | `an ordinary employee CANNOT change a colleague` | ✅ |
| REQ-003 | Notification within 60s | — | — | ❌ **no queue exists** |
| REQ-004 | Point-in-time returns exactly one row | integration | `Engineering on 31 Aug, Payments on 1 Sept` | ✅ |
| REQ-004 | Headcount counts once, in one unit | integration | `headcount counts the person exactly once` | ✅ |
| REQ-004 | Survives a reorganisation | integration | `MAJOR-1` block | ✅ |
| REQ-005 | Own record + history | — | — | ❌ **not implemented** |
| REQ-006 | Self-correct allowlist enforced server-side | unit | allowlist shape only | ⚠️ **partial — no enforcing function** |
| REQ-007 | Directory + field visibility | — | — | ❌ **not implemented** |
| REQ-008 | Bulk import | — | — | ❌ **not implemented** |
| REQ-009 | Data export | — | — | ❌ **not implemented** |
| REQ-010 | Erasure reaches every store | integration | `BLOCKER-3` block, per-store assertions | ✅ |
| REQ-010 | Legal hold overrides erasure | integration | `COMP-23 — a legal hold blocks erasure` | ✅ |
| RULE-001 | Append-only; original interval preserved | integration | `the ORIGINAL row survives untouched` | ✅ |
| RULE-001 | Retroactive correction, no double rows | integration | `the nasty one` — five boundary dates | ✅ |
| RULE-001 | "What we knew at T" is stable | integration | `BLOCKER-4` block | ✅ |
| RULE-002 | Zero-length intervals excluded | unit + integration | `isValidAt`, boundary sweep | ✅ |
| REL-03 | Double-tap → one version | integration | `a double-tap creates exactly one version` | ✅ |
| REL-08 | Business dates, DST/leap-safe | unit | `assertBusinessDate`, `isValidAt` | ✅ |
| PRIV-07 | No PII in audit payloads | unit + integration | `redact`, `no audit row contains a known PII string` | ✅ |
| COMP-01/34 | Every personal-data column classified | integration | catalogue-driven sweep | ✅ |
| COMP-53 | Audit + ledger immutable to the app | integration | UPDATE/DELETE denied | ✅ |
| SEC-05 | History cannot be hard-deleted | integration | `MAJOR-2` block, four tables | ✅ |

## Not covered, and why — stated plainly

**Five of ten requirements have no implementation to test.** REQ-002, REQ-005, REQ-007, REQ-008 and REQ-009 are specified and not built. `apps/web` is an empty directory, so every `403`/`404`/`422` behaviour in the API contract has no transport layer to live in and is currently untestable end to end.

Also absent: `PERF-01`/`PERF-03`/`PERF-05` budgets (no load test — needs a 50,000-employee fixture), `A11Y-*` (no UI), `I18N-*` (no strings), the `pre_hire → active` and `notice → exited` scheduled transitions (no job runner), and `COMP-31` automated purge (retention values now exist; the job does not).

**This green build is honest about what it covers and silent about what it does not.** Do not read 65 passing tests as "Core HR works."

## Findings raised back to the BA

- **Q-06** — REQ-003's optimistic-concurrency behaviour ("409 stating what changed") is untestable as written: "what changed" is not specified. Raised in the decision log.
- REQ-006's allowlist named `emergency_contact` and `profile_photo`, which had no columns. Added to the schema; the enforcing function is still missing.

## Handoff

**To:** hrms-techno-functional-reviewer
**Ready:** yes — with the coverage gaps above stated, not buried.

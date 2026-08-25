---
feature: 001-core-hr-foundation
artefact: review
author: hrms-techno-functional-reviewer
date: 2026-08-24
status: CLOSED — human verdict PASS WITH FIXES, 2026-08-25 (merge 6477832)
inputs: [10-opportunity.md, 20-requirements.md, 30-design-notes.md, 40-test-plan.md, 99-decision-log.md, packages/db, packages/core, packages/ai]
---

# Review — Core HR foundation

Two review rounds ran against this feature. Both returned FAIL, which triggered the
escalation rule in `docs/00-team-charter.md`. Everything the reviewer found was
real; the round-2 findings were fixed with regression tests.

> **Escalation closed 2026-08-25 — verdict PASS WITH FIXES, decided by a human.**
> Round 3 did not run. Merged to `main` in `6477832`, with CI green on all three
> jobs and 88 tests passing (71 in `packages/core`, 17 in `packages/ai`).
> The debt accepted with that verdict — the five open MINORs below, the
> not-implemented list, the `app.tenant_id` GUC risk, two open questions and one
> `[LAW — VERIFY]` — is itemised in `99-decision-log.md` under the same date.
> **Everything else in this document stands as the reviewer wrote it.**

## Round 1 — FAIL, four blockers

| Finding | Consequence found | Status |
|---|---|---|
| **BLOCKER-1** No authorisation at all beyond tenant isolation | Any authenticated employee could set their own job title to CEO, or rewrite anyone's manager. `actorId` was recorded and never checked. | Fixed — `packages/core/src/policy.ts` |
| **BLOCKER-2** `tenant` table had no RLS | Reviewer read every customer's row and **changed another tenant's data-residency region**. The RLS test's hand-written table list inherited the same omission, so 28 passing tests never saw it. | Fixed — FORCE RLS, writes revoked, test list now swept from `pg_class` |
| **BLOCKER-3** No erasure orchestrator | Six stores written to, none reachable by erasure. REQ-010 exists so later modules have a harness to register against. | Fixed — `erasure.ts`, per-store assertions |
| **BLOCKER-4** `valid_to` overwritten in place | Reviewer ran RULE-001's worked example and got the wrong answer: the same as-at question changed its answer because of something recorded later. Destroys the ability to reproduce a payroll run after a retroactive change. | Fixed — system time via `superseded_at` + append |
| **MAJOR-1** Reorg zeroed a team's headcount | Meera's opening story from the opportunity brief, answered wrongly: live Payments reported 0, the dead row reported 1. | Fixed — identity/version split |
| **MAJOR-2** History hard-deletable by the app role | Two rows of employment history deleted from a normal session. | Fixed — DELETE then UPDATE revoked, with column grants |
| **MAJOR-3** No cycle check; cross-tenant manager FK accepted | A reporting loop hangs the org chart for the whole tenant; FK checks bypass RLS. | Fixed — `findReportingCycle`, composite FK |
| **MAJOR-4** Classification gate covered one table | 41 columns unclassified, including `work_location` — a proxy for protected characteristics. | Fixed — catalogue-driven, `table.column` exclusions |
| **MINOR-1** Dead code dressed as safety controls | `POINT_IN_TIME_SQL` was never imported and its placeholder syntax could never have worked. | Fixed |

## Round 2 — FAIL, one blocker (since fixed)

Seven of eight round-1 findings verified closed by re-running the original probes.
The remaining blocker and three majors:

| Finding | Consequence found | Status |
|---|---|---|
| **BLOCKER** `hasLegalHold()` checked `status = 'notice'` | Not a legal hold. An ex-employee under litigation hold is `exited`, so a POSH respondent's record would be erased on request, destroying the complainant's evidence — with a green test named "a legal hold blocks erasure" cementing the wrong semantics. | Fixed — real `legal_hold` table |
| **MAJOR-1** `actor` and `principal` unlinked | Authorisation checked one, `decided_by` recorded the other. Accountability was forgeable. | Fixed — one identity parameter |
| **MAJOR-2** UPDATE not revoked on version tables | The system-time chain was still silently rewritable. | Fixed — revoked, with two column grants |
| **MAJOR-3** AI gateway out of scope, untested, CI red | `pnpm -r test` exited 1, so the cross-tenant RLS suite was gating nothing. | Fixed — 17 gateway tests |

## Still open (MINOR)

- `findReportingCycle` runs before the `FOR UPDATE` lock — two concurrent manager swaps could both pass
- `employmentAsKnownAt` returns `rows[0]` where `employmentAsOf` throws on >1
- `SELF_CORRECTABLE` is still an allowlist with no enforcing function
- ISO dates in user-facing messages instead of locale-formatted (`I18N-02`)
- `withTenant`'s `ROLLBACK` can mask the original error

## Not implemented — stated, not re-argued

REQ-002 (create employee) · REQ-005 (own record + history) · REQ-006 (self-correction) ·
REQ-007 (directory) · REQ-008 (bulk import) · REQ-009 (export) · change notifications
(no queue) · retention purge job · employment state-machine transitions (no job runner) ·
skip-level permissions · `apps/web` transport layer.

**This green build is honest about what it covers and silent about what it does not.
Do not read the passing tests as "Core HR works."**

## Named as done well

- **The column-level `GRANT UPDATE`** resolving append-only versus erasable — two genuine
  obligations that contradict each other, resolved at the narrowest possible scope, with the
  tension written into the decision log and marked `[LAW — VERIFY]` rather than asserted.
  The reviewer: *"I raised the erasure gap; I did not suggest this, and it is better than
  what I would have asked for."*
- **The RLS test connects as `hrms_app`**, a `NOBYPASSRLS` non-owner role — *"testing RLS as
  the superuser would prove nothing."* The single most commonly faked test in this
  architecture. It also asserts `relforcerowsecurity` per table and `rolbypassrls` on the
  role, and fails if its own catalogue sweep returns too few tables.
- **The system-time fix is correct, not merely present** — appending a replacement rather
  than reaching for full interval bitemporality keeps the hot path almost unchanged while
  making the as-at answer immutable.
- **The decision log is honest about being wrong** — the Q-03 entry records that the first
  attempt was caught by asking the same question twice, and carries the `app.tenant_id`
  GUC risk forward as open rather than closing it.

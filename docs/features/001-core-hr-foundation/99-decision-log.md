---
feature: 001-core-hr-foundation
artefact: decision-log
status: append-only
---

# Decision log — Core HR foundation

Append only. Corrections append; they never overwrite.

### 2026-08-24 — Q-03 resolved: temporal model
**From:** hrms-product-manager → hrms-fullstack-engineer
**Question:** full bitemporality in v1, or append-only versioning with `recorded_at`?
**Decision:** **Bitemporal.** Business time `[valid_from, valid_to)` **and** system time `[recorded_at, superseded_at)`.
**Why:** the first design attempt narrowed this to "never update *business data*" and treated `valid_to` as exempt — then overwrote it in place. The reviewer proved that destroys the only record of what we believed, by asking the same as-at question before and after a retroactive correction and getting two different answers. `valid_to` **is** the answer to the system-time question. The trigger named in RULE-001 ("the first payroll run that must be reproduced exactly after a retroactive change") had already fired, in this module, before payroll exists.
**Cost:** one extra column and an append instead of an update. Cheap now; a migration of every row later.

### 2026-08-24 — Multi-tenancy: shared schema + FORCE RLS
**Decision:** shared schema, `tenant_id` on every table, `FORCE ROW LEVEL SECURITY`, tenant from a transaction-local session setting, fail-closed when unset.
**Rejected:** schema-per-tenant — stronger isolation, but migrating thousands of schemas per release would dominate engineering time.
**Revisit when:** a customer contractually requires physical isolation. **This is a migration, not a refactor.**
**Accepted risk, recorded on the reviewer's note:** `app.tenant_id` is an ordinary GUC the app role can set freely, so any SQL-injection defect anywhere escalates directly to a full cross-tenant breach. A `SECURITY DEFINER` setter or per-tenant roles would close this. **Open — owner: hrms-fullstack-engineer.**

### 2026-08-24 — Org units and positions: identity split from version
**Decision:** `org_unit` (stable identity) + `org_unit_version` (effective-dated attributes). Same for `job_position`.
**Why:** conflating them meant a reorganisation created a *new* org unit, orphaning every `employment_version` pointing at the old row. The reviewer reproduced Meera's opening story from the opportunity brief and got the wrong answer: the live Payments unit reported 0 people, the dead row reported 1, and neither was labelled.

### 2026-08-24 — Q-01 / Q-02 resolved
One active employment per person per tenant, enforced by a partial unique index. Rehire reuses the `person` and creates a new `employment`. "Tenure" and "total tenure" are different numbers and the UI must say which it is showing.

### 2026-08-24 — Append-only vs erasable: column-level grants
**Tension:** `COMP-53` says the transparency ledger and audit log are immutable. `COMP-22` says erasure must reach every store. `transparency_ledger.decided_by_name` is denormalised precisely so the ledger still says who decided after that person leaves — which is what makes it un-erasable.
**Decision:** `REVOKE UPDATE` on the tables, then `GRANT UPDATE (decided_by_name)` and `GRANT UPDATE (actor_id)` at **column** level. Erasure can pseudonymise exactly those two fields; every other column, `reason` included, stays immutable to the application.
**`[LAW — VERIFY]`** that pseudonymisation rather than deletion is sufficient here in each market.

### 2026-08-24 — Q-04 / Q-05 resolved
**Q-04:** future-dated changes are visible to the employee immediately. Surprise is the enemy of trust.
**Q-05:** managers do **not** see who else viewed their team members' records — that is surveillance of HR by managers. Employees see it about themselves; HR sees it. (`docs/07-fairness-and-transparency.md` Part 2.)

### 2026-08-24 — Open, blocking payroll not Core HR
**Q-07 → legal:** does any statutory filing require the historical legal name at the time of the transaction? Legal name is currently corrected in place with full audit history, not effective-dated.
**Q-06 → BA:** REQ-003's 409 response must specify *what* "what changed" contains, or it cannot be tested.

### 2026-08-24 — Legal hold is a table, not an employment status
**Raised by:** hrms-techno-functional-reviewer, round 2, BLOCKER.
**What was wrong:** `hasLegalHold()` returned true when `employment.status = 'notice'`, was documented `COMP-23`, and had a passing test named "a legal hold blocks erasure". It was a green test cementing the wrong semantics — the same shape as round 1's hand-maintained `TENANT_SCOPED` list surviving 28 passing tests.
**Why it mattered:** an ex-employee under litigation hold is `exited`, so their record would have been erased on request — destroying a complainant's evidence irreversibly, with no audit entry. And every employee serving notice was silently un-erasable.
**Decision:** a real `legal_hold` table — reason, who placed it, when, scope, release — under RLS, with `UPDATE`/`DELETE` revoked and a column grant for release only.

### 2026-08-24 — One identity parameter, not two
**Raised by:** reviewer, round 2, MAJOR.
`applyEmploymentChange` took both `actor` and `principal` and compared them nowhere: authorisation checked one, `decided_by` recorded the other. The fairness charter's accountability property was a column populated from a value the authorisation check never looked at. `Actor` is now derived from `Principal` inside the function.

### 2026-08-24 — REVOKE UPDATE on the version tables
**Raised by:** reviewer, round 2, MAJOR.
Round 2 revoked DELETE and left UPDATE open, so the system-time chain that the Q-03 decision exists to protect was one bad script from a silent rewrite. Now revoked at table level with column grants for the two legitimate paths (`superseded_at` for the change path, `reason` for erasure) — the same narrow-scope pattern used for the ledger.

### 2026-08-24 — The AI gateway stays, with tests
**Raised by:** reviewer, round 2, MAJOR — the gateway is out of this feature's scope, untested, and made `pnpm -r test` exit 1 (so CI was red and the RLS suite was gating nothing).
**Decision:** keep it, because the deployment decision (hosted model API) makes the boundary a standing constraint rather than a feature-specific one, and CI enforces "no model access outside `packages/ai`" from day one. But land it properly: 17 tests, one per guard. An asserted-but-unverified guard is how someone ends up ticking `AI-02` because they saw the right string in a source file.
**Still true:** Core HR uses no AI. `COMP-70`–`COMP-79` remain out of scope for feature 001.

### 2026-08-24 — ESCALATED TO A HUMAN
Two consecutive FAIL verdicts on this feature triggered the escalation rule in `docs/00-team-charter.md`. The reviewer's own note: *"the two-FAIL rule has fired on a ~30-line defect in a code path nothing can currently call — fixing the blocker and re-verifying is a day's work, not a reset."*
Round-2 blocker and all three majors are now fixed with regression tests. **A human decides whether round 3 proceeds.** Open minors are listed in `50-review.md`.

### 2026-08-25 — ESCALATION CLOSED: PASS WITH FIXES
**Decided by:** a human, resolving the escalation entry above. Round 3 did not run; the human took the decision directly.
**Verdict:** **PASS WITH FIXES.** Merged to `main` in **6477832** (`--no-ff`, so the branch history is preserved).
**Evidence at the time of the decision:** every round-1 and round-2 blocker and major fixed with regression tests; CI green on all three jobs (`test`, `ai-gateway-boundary`, `classification-coverage`); 88 tests pass — 71 in `packages/core`, 17 in `packages/ai`. The RLS suite connects as `hrms_app`, a `NOBYPASSRLS` non-owner role, so it proves something.

**Accepted debt — shipped knowingly, not overlooked:**

1. **Five open MINORs** (listed in `50-review.md`): `findReportingCycle` runs before the `FOR UPDATE` lock, so two concurrent manager swaps could both pass; `employmentAsKnownAt` returns `rows[0]` where `employmentAsOf` throws on >1; `SELF_CORRECTABLE` is an allowlist with no enforcing function; ISO dates in user-facing messages instead of locale-formatted (`I18N-02`); `withTenant`'s `ROLLBACK` can mask the original error.
2. **Not implemented**: REQ-002, REQ-005, REQ-006, REQ-007, REQ-008, REQ-009, change notifications (no queue), the retention purge job, employment state-machine transitions (no job runner), skip-level permissions, and the `apps/web` transport layer.
3. **The `app.tenant_id` GUC risk** stays open — it is an ordinary GUC the app role can set freely, so any SQL-injection defect anywhere escalates to a full cross-tenant breach. **Owner: hrms-fullstack-engineer.**
4. **Two open questions** carried forward: Q-07 → legal (does any statutory filing require the historical legal name at the time of the transaction?) and Q-06 → BA (what `REQ-003`'s 409 response must contain).
5. **`[LAW — VERIFY]`** that pseudonymising `decided_by_name` and `actor_id` rather than deleting them satisfies erasure in each market.

**What this verdict does not mean.** A green build covers the paths that exist. Core HR is not done, and the not-implemented list above is the proof. `50-review.md`'s own warning stands: do not read the passing tests as "Core HR works."

### 2026-08-26 — `actor_id` is an employment id, and the database enforces it

**Raised by:** a human, against the SHIPPED code on `main`, after the PASS WITH FIXES verdict above.
**Severity:** live COMP-22 / PRIV-10 defect. Erasure did not erase.

**What was wrong.** `audit_log.actor_id`, `analytics_event.actor_id` and
`transparency_ledger.decided_by` were plain `uuid` columns with **no foreign key**. Nothing
said which kind of id they held. `packages/core/src/employment.ts` wrote `principal.actorId`
into them — a login account id — while `packages/core/src/erasure.ts` looked for them with
`WHERE actor_id IN (SELECT id FROM employment WHERE person_id = $1)`. The two never met.

Reproduced before fixing, through the real code path on postgres:16:

```
auditRowsThatExist:                1     ledgerRowsThatExist:            1
auditMatchedByErasurePredicate:    0     ledgerMatchedByErasurePredicate: 0
hrIdPresentInEmployment:           0     analyticsRowsThatExist:         1
after erasePerson — rows still naming the actor: audit 2, ledger 1, analytics 1
                                         ledger names NOT replaced: 1
```

Compare `transparency_ledger.subject_employment_id uuid NOT NULL REFERENCES employment(id)`.
**The subject of a decision was constrained from day one. The decider was not.**

**Why the tests did not catch it.** `fixes.test.ts` asserted with *the erasing code's own
predicate*, so it compared zero to zero. Three of its four store assertions — ledger, audit,
analytics — passed vacuously and would have passed with the erasure step deleted entirely.
Only `employment_version` was genuine, because it matches on `employment_id`, which is real.
`test/setup.ts` hardcoded `hrId = '00000000-0000-0000-0000-0000000000aa'` and never inserted
it into `employment`; the fixture and the production code were wrong in the same direction,
so neither could reveal the other. **This is the third instance of the pattern the reviewer
caught twice: a green test cementing wrong semantics** — after the hand-written
`TENANT_SCOPED` list and `hasLegalHold()` checking `status = 'notice'`.

**Second defect found while fixing the first.** `expect(row.decided_by).toBe(rohan().actorId)`
is a tautology, and every principal helper in the suite shared `actorId: A.hrId`. So a change
Rohan made was recorded as decided by HR, under a test named *"the accountable human cannot be
forged"*. Round 2's "one identity parameter" fix collapsed `actor` and `principal` into one
**parameter** but left two **fields** on `Principal` and picked the wrong one. The
accountability promise in `docs/07-fairness-and-transparency.md` Part 2 was not being kept.

**Decision.** `actor_id` / `decided_by` always mean **`employment.id`**, enforced three ways:

1. **Schema** — migration `0002_actor_is_an_employment.sql` adds a **composite** foreign key
   `(tenant_id, <column>) REFERENCES employment (tenant_id, id)` to every accountability
   column: `audit_log.actor_id`, `analytics_event.actor_id`, `transparency_ledger.decided_by`,
   `employment_version.decided_by`, `org_unit_version.decided_by`, `legal_hold.placed_by`,
   `legal_hold.released_by`. Composite for the same reason `ev_manager_same_tenant` is:
   FK checks bypass RLS, so a single-column key accepts another tenant's employment.
2. **Type** — `Principal` has ONE identity field, `actorEmploymentId: EmploymentId`, non-null.
   `EmploymentId` is branded, so a bare `string` does not assign. There is no second slot to
   put the wrong value in.
3. **Derivation** — `Actor` is now the `Principal`, not a value built beside it.

`NULL` stays legal on the two nullable columns: a composite FK is MATCH SIMPLE, so
"NULL, or a real employment in this tenant" is exactly the erasure behaviour COMP-22 needs
against COMP-53's append-only rule.

**Rejected alternatives.**

| Option | Why not |
|---|---|
| Make `actor_id` a `person.id` | The whole policy layer reasons in employment ids (`manager_employment_id`, self-checks). It would move the conflation rather than remove it, and a rehire gives one person two employments — "which employment acted" is the question an auditor asks. |
| Split into `actor_employment_id` + `actor_account_id` | Honest, but keeps two fields, and the defect was two fields. The login account belongs in the session/authentication log, not in a per-row accountability column. Revisit only if an auditor asks which login session performed an action. |
| Leave the column, add a `CHECK` or fix it in application code | A check cannot reference another table; application discipline is what failed here. `packages/core` is not the only thing that will ever write these tables. |
| Allow a nullable actor for non-human callers | Deferred deliberately. There is no non-human writer today. A future import or purge job needs its **own modelled identity**, not a nullable column that quietly re-admits "we do not know who this is". **Open — owner: hrms-fullstack-engineer.** |

**Consequence accepted:** an actor with no employment in this tenant **cannot act on
employment records.** The old comment "HR admins usually do [have an employment]" is now a
requirement. A support engineer acting cross-tenant already needed a modelled, audited
impersonation path (`COMP-42`); this makes that explicit rather than silently allowing an
unconstrained uuid.

**`test/setup.ts`'s hardcoded `hrId` is gone**, replaced by a real seeded employment (Meera,
People Ops) generated per tenant. The constant also meant tenants A and B *shared* an actor
id, which weakened the cross-tenant tests that used `B.hrId`. Meera is seeded into her own
org unit, not Engineering, so REQ-004's headcount numbers stay exactly as written — a fixture
that moves a headcount hides a regression.

**Also found and fixed while here.** `erasePerson` wrote its own audit entry *after* the
`audit_log` eraser ran. Harmless while `actor_id` matched nothing; with the fix in place a
self-service erasure would re-link the erased person's employment into the store just cleared.
A self-service erasure now records a NULL actor and flags `selfService` in the payload.

**Also found: TypeScript was never type-checked.** No `typecheck` script existed anywhere and
`@types/node` was not installed, so `tsc` had never run on this repo — `vitest` strips types
without checking them. The branded type above would have been decorative. Added `typecheck`
to both packages, wired into `pnpm test` and into CI as its own step. `@types/node` is pinned
to `^22` to match the Node 22 LTS runtime; `^26` types would describe APIs that are not there.

**Also fixed: the test harness and the classification CI gate both applied only
`0001_core_hr_foundation.sql` by name**, so any later migration was untested and unchecked.
Both now apply every migration in sorted order.

**`[LAW — VERIFY]`** unchanged from 2026-08-24: that pseudonymising `decided_by_name` and
NULLing `actor_id`, rather than deleting the rows, satisfies erasure in each market.

**Evidence.** Regression test `packages/core/test/actor-referent.test.ts` written first and
run against the shipped code: **5 failed / 5**. After the fix: **5 passed**. Full suite
**93 passed** (76 `packages/core`, 17 `packages/ai`), up from 88. Migration verified applied
from scratch, rolled back via its documented down path, and its pre-flight guard verified to
refuse a database holding a bad actor id.

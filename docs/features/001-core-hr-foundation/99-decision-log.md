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

# Definition of Done

A feature is done when a human could be woken at 3am, shown this checklist, and go back to sleep.

## Gate 0 — Simplicity (applies to every agent, every artefact)

Answer all four in writing. Any "no" or "cannot answer" means cut scope before continuing.

1. **What does this complexity buy?** Name the specific user outcome. "Flexibility" and "future-proofing" are not answers.
2. **What is the simplest version that delivers 80% of the value?** Why are we not shipping that instead?
3. **Can Aisha complete the main action in under 10 seconds on her phone?** If not, why is the extra time worth it?
4. **What did we deliberately leave out?** An empty non-goals list means scope was never controlled.

### Over-engineering smells (specific to HR software)

| Smell | Simpler alternative |
|---|---|
| A configuration screen for something nobody has asked to vary | Hard-code it; make it configurable when the second customer asks |
| A workflow engine before the first workflow ships | One hard-coded approval chain, extracted after the third one exists |
| Custom fields on everything from day one | Custom fields on the 2–3 objects customers actually extend (employee, candidate) |
| A microservice per HR module | One deployable; split when a boundary hurts, not before |
| A permissions DSL | A role table and a policy function, until the third exception |
| An AI feature where a sorted list would do | The sorted list |
| Real-time everything | Nightly recalculation, unless the user is waiting on the screen |

## Gate 1 — Functional

- [ ] Every requirement in `20-requirements.md` maps to at least one passing test, by ID
- [ ] The critical path runs end to end in a real environment, not just unit tests
- [ ] Negative cases pass: invalid input, unauthorised access, downstream failure, empty state, huge data
- [ ] Every persona named in the requirement has been walked through the flow

## Gate 2 — Non-functional

Reference `03-nfr-catalog.md` by ID. At minimum, for every feature:

- [ ] **SEC** — authorisation tested at the API level, not just hidden in the UI
- [ ] **PRIV** — personal data touched is listed; retention and export behaviour is defined
- [ ] **PERF** — the p95 budget is asserted in a test, with a real-ish data volume
- [ ] **REL** — failure of each dependency has a defined behaviour (retry / fallback / escalate / safe-stop)
- [ ] **OBS** — structured logs, one trace per request, business events emitted, no PII in logs
- [ ] **A11Y** — keyboard-only pass, automated axe scan clean, screen-reader labels present
- [ ] **AI** (if applicable) — autonomy bounds enforced in code, prompt-injection cases tested, eval set passing, cost per call measured, human-in-loop on adverse decisions

## Gate 2b — Compliance

Reference `docs/05-compliance-catalog.md`. Skip only if the feature touches no personal data at all — which for an HRMS is rare enough that you should double-check.

- [ ] **COMP** — every personal-data field classified, with purpose, lawful basis and retention recorded as metadata
- [ ] Retention is configuration with a statutory reference; the purge job runs and honours legal hold
- [ ] The data appears in the person's own view and export, including derived values
- [ ] **Erasure propagates to every store the feature writes to** — proven by a test that checks each store independently, not by inspection
- [ ] Consent (where used) is ledgered; withdrawal is immediate, equally easy, and does not break the person's ability to work
- [ ] Audit log covers sensitive reads and is append-only at the storage layer
- [ ] Anonymity promises have no query path to identity; small-group suppression enforced in the query layer
- [ ] Any new third party touching personal data — model providers included — is in the sub-processor register with a transfer mechanism
- [ ] Every legal statement marked `[LAW — VERIFY]`; nothing asserted as settled law
- [ ] **If AI touches recruitment, selection, performance, task allocation, monitoring, promotion or termination:** classified high-risk; recorded human decider with no API path around it; decision logs retained; bias-audit export exists; notice, explanation and contest route present; per-tenant kill switch tested
- [ ] Anything reaching a payslip, a rejection, a termination or a regulator has human legal sign-off

## Gate 3 — Correctness-critical (payroll, leave, attendance, money, time)

Only skip this section if the feature touches none of them.

- [ ] Money is integer minor units + currency; no floating point anywhere in the path
- [ ] Every calculation has a worked example in the requirements with the expected number to the paisa/cent
- [ ] The operation is idempotent — running it twice does not pay twice
- [ ] Rounding rules are stated and tested, including the half-way case
- [ ] Effective-dated history is preserved; a retroactive change recalculates correctly
- [ ] Timezone and business-date handling tested across a DST boundary and a month boundary
- [ ] An auditor can trace any output number back to its inputs

## Gate 4 — Operability

- [ ] Migration is reversible, or has a documented forward-fix
- [ ] Feature flag exists and default-off has been tested
- [ ] Rollback plan written in one paragraph a tired on-call engineer can follow
- [ ] Dashboards/alerts exist for the new failure modes
- [ ] Runbook entry for the top two things that will page someone

## Gate 5 — Human

- [ ] Reviewer verdict is PASS or PASS WITH FIXES (all fixes applied and re-verified)
- [ ] The decision log has no unanswered blocking questions
- [ ] Someone who did not build it used it once and got through without help

## Evidence rule

"Done" claims need evidence: command output, test results, a screenshot, a trace. Recollection is not evidence. An agent that says "tests pass" without pasting the run output has not tested anything.

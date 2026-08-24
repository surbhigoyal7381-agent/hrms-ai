---
description: Audit a module against the data protection, security standards and AI-in-HR compliance catalogue
argument-hint: '[module or path] [jurisdictions, e.g. India EU NYC]'
disable-model-invocation: true
---

Audit **$ARGUMENTS** against `docs/05-compliance-catalog.md`.

Use the `hrms-techno-functional-reviewer` subagent (read-only). Give it these instructions:

**1. Scope it.** Name the jurisdictions in play and which frameworks therefore apply. If I did not name jurisdictions, ask me before guessing — the answer changes everything downstream.

**2. Walk the module row in §3** of the compliance catalogue. For each compliance feature that module is supposed to have, report:

- **BUILT** — with the file, line, or test name proving it
- **CLAIMED BUT ABSENT** — the requirement or the UI says it exists and the code does not. **This is the worst category and it is always a BLOCKER.** An anonymity promise with a query path to identity, a retention policy with no purge job, an erasure that misses the search index, a "human reviews this" that has no recorded decider.
- **MISSING** — not built, and not claimed
- **N/A** — with the reason

**3. Then walk the COMP-* IDs** in §2: governance records, consent, data-principal rights, retention, cross-border transfer, security controls, breach response, and — if any AI touches recruitment, selection, performance, task allocation, monitoring, promotion or termination — the full `COMP-70`–`COMP-79` high-risk set.

**4. Check these four specifically, in the code, because they are where the real gaps are:**

- Compare the list of stores this module **writes to** against the list of stores **erasure touches**. Any gap is a blocker.
- Try to write the de-anonymising query yourself against any data promised anonymous. Do not trust the UI.
- Check the audit table's grants, not the application code, for append-only enforcement.
- Trace the API layer (not the UI) for any path that finalises a high-risk AI outcome without a recorded human decider.

**5. Report:**

- The **claimed-but-absent** list first — these are what turn into regulatory findings and broken promises to employees
- Then gaps ranked by consequence to a real person, not by effort to fix
- What is needed for a security questionnaire or an ISO/SOC audit, and what is already there
- Every legal statement marked `[LAW — VERIFY: source, as of date]`
- A closing line naming what must go to qualified counsel before shipping into these markets

Edit nothing. You are not a lawyer — this is a gap analysis to take to one.

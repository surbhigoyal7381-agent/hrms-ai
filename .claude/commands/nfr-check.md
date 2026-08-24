---
description: Audit an existing area of the codebase against the HRMS NFR catalogue
argument-hint: [module, path, or "the whole app"]
disable-model-invocation: true
---

Audit $ARGUMENTS against `docs/03-nfr-catalog.md`.

Use the `hrms-techno-functional-reviewer` subagent. It should go category by category — SEC, PRIV, PERF, SCALE, REL, OBS, A11Y, I18N, AI, COST, UX — and for each NFR ID report one of:

- **MET** — with the evidence (file, line, or test name)
- **NOT MET** — with the concrete failure scenario
- **UNKNOWN** — cannot tell without running something; say exactly what to run
- **N/A** — with the reason

Finish with the five highest-risk gaps ranked by consequence to a real person, not by effort to fix. Edit nothing.

---
description: Run a new HRMS feature through the full 5-agent pipeline, stopping at each gate
argument-hint: [feature name or short description]
disable-model-invocation: true
---

Run the feature **$ARGUMENTS** through the HRMS agent pipeline.

Before you start:
1. Read `CLAUDE.md`, `docs/00-team-charter.md` and `docs/01-handoff-protocol.md`.
2. Pick the next feature number by listing `docs/features/`. Create `docs/features/<NNN>-<slug>/`.

Then run the stages **in order, stopping after each one for my approval before continuing**. Do not run all five without pausing — the whole point of the gates is that I get to redirect early, when it is cheap.

**Stage 1** — Use the `hrms-product-manager` subagent to write `10-opportunity.md` for: $ARGUMENTS
→ Show me the recommended scope and the ★ wow moment. Wait for my go-ahead.

**Stage 2** — Use the `hrms-business-analyst` subagent to write `20-requirements.md` from `10-opportunity.md`.
→ Show me the requirement count, the edge cases found, and any blocking questions. Wait.

**Stage 3** — Use the `hrms-fullstack-engineer` subagent to write `30-design-notes.md`, then implement.
→ Show me the design note before it writes code. Wait. Then let it implement.

**Stage 4** — Use the `hrms-test-automation` subagent to write `40-test-plan.md` **from the requirements**, then write and run the tests.
→ Show me the traceability table and the full test report. Wait.

**Stage 5** — Use the `hrms-techno-functional-reviewer` subagent to write `50-review.md`.
→ Show me the verdict on the first line.

If the verdict is FAIL or PASS WITH FIXES, send the findings back to `hrms-fullstack-engineer`, then re-run stage 5. If it FAILs twice, stop and tell me — do not loop.

At the end, print a one-paragraph plain-language summary of what was built and what is not covered.

---
description: Run the read-only techno-functional review gate on a feature, PR, or path
argument-hint: [feature folder, path, or "the current diff"]
disable-model-invocation: true
---

Use the `hrms-techno-functional-reviewer` subagent to review: $ARGUMENTS

Give it these instructions:
- Read `CLAUDE.md` and `docs/03-nfr-catalog.md` first, then the feature's requirements, then the code.
- Re-run the test suite yourself and paste the real output.
- Reproduce at least one worked example from the business rules and check the number.
- Put the verdict on the first line.
- Edit nothing.

Then show me: the verdict, every BLOCKER and MAJOR finding, and the one thing that was done well.

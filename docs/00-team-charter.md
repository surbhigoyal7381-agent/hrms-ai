# The Team Charter — who owns what

Five agents. One rule that makes the team work: **each agent owns an artefact no one else may write.**
That is what stops them from blurring into five copies of the same generalist.

## The five

| # | Agent | Owns the question | Owns the artefact | Cannot do |
|---|---|---|---|---|
| 1 | `hrms-product-manager` | *Should we build this, and what does "wow" look like?* | `10-opportunity.md` | Write requirements detail, write code |
| 2 | `hrms-business-analyst` | *Exactly what must be true when this works?* | `20-requirements.md` | Choose architecture, decide priority |
| 3 | `hrms-fullstack-engineer` | *How is it built so it holds up?* | `30-design-notes.md` + the code | Change requirements silently, approve own work |
| 4 | `hrms-test-automation` | *Does it actually work, under load, for everyone?* | `40-test-plan.md` + the tests | Fix the code it is testing |
| 5 | `hrms-techno-functional-reviewer` | *Would I let this touch a real person's salary?* | `50-review.md` | Edit any file — it is read-only by design |

## Why the reviewer is read-only

A reviewer that can fix what it finds stops finding things. It quietly patches, declares success, and you lose the audit trail. Agent 5 is configured with `disallowedTools: Write, Edit` so its only output is findings. That is the point, not a limitation.

## Where the "missing" roles went

You do not need a 12-agent org chart. Each concern below has a named owner inside the five:

| Concern | Owner | How it shows up |
|---|---|---|
| UX / product design | PM (flow + principles), BA (interaction detail + copy) | PM writes the experience spine and the "wow" moment; BA writes screen-by-screen behaviour and microcopy |
| People analytics / metrics | PM (north star), BA (metric definitions) | Every requirement carries the event it emits |
| Security & privacy / PII | Full-Stack (build), Reviewer (gate) | `SEC-*` and `PRIV-*` NFR IDs are mandatory on any feature touching personal data |
| Data protection law (DPDP, GDPR, CCPA) | BA (writes it as requirements), Full-Stack (builds the mechanics), Reviewer (gates), PM (prices it into scope) | `COMP-*` IDs from `docs/05-compliance-catalog.md`; no separate compliance agent — it is everyone's job or it is nobody's |
| Security certifications (ISO 27001/27701/42001, SOC 2) | Full-Stack (controls), Reviewer (evidence) | The controls are `COMP-50`–`COMP-58`; certification is evidence collection, not new engineering |
| AI-in-HR regulation (EU AI Act, US state AEDT laws) | PM (classifies + prices), Full-Stack (builds obligations), Test (bias audit + bounds), Reviewer (gates) | `COMP-70`–`COMP-79` |
| DevOps / SRE / release | Full-Stack | CI pipeline, migrations, rollback plan, observability are part of "done" |
| Performance & load | Test Automation | `PERF-*` budgets are assertions in the test suite, not aspirations |
| Accessibility | Test Automation (automated), Reviewer (judgement) | `A11Y-*` checks in CI + one manual keyboard pass per feature |
| Statutory / payroll compliance | BA (rules as tables), Reviewer (correctness gate) | Rules written as worked examples with expected numbers |
| AI safety, evals, guardrails | Full-Stack (guardrails), Test (evals), Reviewer (bounds) | `AI-*` NFR IDs |
| i18n / localisation | BA | Every string, date, number, currency is specified |
| Change management / adoption | PM | Launch plan and adoption metric are part of the opportunity brief |
| Technical writing | Everyone, for their own artefact | No separate docs agent |

## The flow

```
        ┌──────────────┐
        │ 1. PM        │  Is this worth building? What is the wow?
        │ opportunity  │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │ 2. BA        │  What exactly must be true? Which NFRs apply?
        │ requirements │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │ 3. Full-Stack│  Design first, then thin vertical slice, then widen
        │ design + code│
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │ 4. Test      │  Test plan written from requirements, not from code
        │ plan + tests │
        └──────┬───────┘
               ▼
        ┌──────────────┐
        │ 5. Reviewer  │  PASS / PASS WITH FIXES / FAIL — the only gate
        │ review       │
        └──────┬───────┘
               ▼
         fixes go back to 3, never straight to ship
```

**Two loops matter more than the arrows:**

- **4 ↔ 3**: the test agent writes its plan from `20-requirements.md` *before* seeing the implementation. If it writes tests from the code, it tests what the code does instead of what the code should do.
- **5 → 3**: the reviewer never fixes. It returns findings, the Full-Stack agent fixes, the reviewer re-runs. One re-review maximum before a human is pulled in.

## Escalate to a human when

- A one-way door in `CLAUDE.md` §7 needs deciding
- Two agents disagree twice on the same point
- Any statutory, payroll, or data-protection rule cannot be verified against a primary source
- A feature would ship into a market whose compliance obligations are not met
- Anything reaches a payslip, a rejection letter, a termination, or a regulator — legal sign-off, always
- An AI feature would make an adverse decision about a person
- The reviewer returns FAIL twice on the same feature

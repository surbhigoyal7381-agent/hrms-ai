---
feature: 001-core-hr-foundation
artefact: opportunity
author: hrms-product-manager
date: 2026-08-24
status: draft
inputs: []
---

# Core HR — employee master, org structure, positions

## The problem, as a story

Meera (HRBP) is asked a question in a Monday leadership meeting: *"How many people report into the Payments org, and how many of those joined in the last six months?"*

She opens a spreadsheet that someone exported from somewhere in June. It has 412 rows. She knows at least four people have left and two teams were merged. She says "let me get back to you." It takes her two days, three Slack threads, and a call with Sunil in payroll — who has a different number, because his list is built from who got paid, and hers is built from who has a laptop.

Neither number is wrong. They are answering different questions from different sources, and **nobody in the company can name the source of truth.**

Meanwhile Aisha changed her legal name in March. She told HR. It is updated in the payroll system, not in the directory, so her badge, her email signature, and the org chart still show the old name. Every time someone new joins her team she has the conversation again.

## Who is affected, how often, at what cost

| Persona | Frequency | Cost today |
|---|---|---|
| Meera (HRBP) | Several times a week | Hours per question; answers she cannot defend |
| Sunil (Payroll) | Every cycle | Reconciliation against a list he does not trust |
| Priya (CHRO) | Monthly | Decisions made on numbers with unknown provenance |
| Rohan (Manager) | On every joiner/leaver/transfer | Chases HR for changes that should be self-service |
| Aisha (Employee) | Rarely, but it lands hard | Her own record is wrong and she cannot fix it |
| Dev (IT) | Every joiner/leaver | Manual provisioning from a stale list; **an access-revocation gap is a security incident** |

**What breaks if we do nothing for six months:** nothing else can be built. Leave needs to know who reports to whom. Payroll needs effective-dated pay history. Engagement needs teams. Analytics needs a headcount definition. Core HR is not a module — **it is the floor everything else stands on.** Getting the shape wrong here is not a refactor, it is a rewrite.

## Pillar and metric

**Primary pillar: Transparency.** Aisha can see her own record, its history, and who changed it. Everyone can see the real org structure.
**Secondary: Collaboration** — a directory and org chart people actually use is the substrate for cross-team work.

**North star:** *% of employee records that are self-service-correct* — the share of people whose record needed no HR ticket to be right this quarter. Baseline unknown; measuring it is task one.

**Guardrail metrics:** zero cross-tenant data exposure (non-negotiable, not a metric that trades against others) · p95 directory load · time-to-provision for a new joiner.

**Counter-metric:** *number of fields on the employee form*. If this product succeeds by asking HR to enter 60 fields per person, it has failed. Watch it go up and push back.

**Kill criteria:** if after two pilot tenants Meera still exports to a spreadsheet to answer a basic headcount question, the data model is wrong and we stop and redesign rather than adding reports.

## What competitors do

Every HRMS has an employee master; this is table stakes, and we win no deals on it. `[UNVERIFIED — positioning below is from general market knowledge, not researched this session; do not use in sales material without checking]`

- **Enterprise suites** (Workday, SuccessFactors, Oracle HCM) have genuinely sophisticated effective-dated position management. They are also slow, expensive, and require a certified consultant to change a job title.
- **Mid-market** (BambooHR, HiBob, Rippling) are much better at the employee experience, and generally weaker on effective-dated history and complex org structures.
- **India** (Darwinbox, Keka, Zoho People, greytHR) are strong on statutory payroll integration.
- **ERPNext / Frappe HR** is open source and worth reading for its HR data model — a useful free reference even though it is not our stack.

**The shared blind spot:** in almost all of them, the employee record is something *done to* the employee. They can view a profile page. They cannot see its history, cannot see who changed what, and cannot correct an error without filing a ticket that goes into a queue.

## Our angle

**The employee record belongs to the employee.**

Concretely: Aisha sees her full record, its complete change history with who and why, can correct anything factual about herself directly, and can see who has looked at her sensitive data. That is not a compliance screen bolted on the side — it is the primary employee-facing surface of Core HR, and it is `COMP-20` and the transparency pillar delivered as the same piece of work.

Is it defensible? Not technically — anyone could copy it. It is defensible as **positioning**, because the incumbents' architecture (record-of-truth for HR, read-only view for employees) makes it awkward for them to reverse. Treat it as a hypothesis to test with pilot tenants, not a moat.

## The experience spine

> **Trigger** — Rohan needs to move Aisha to the Payments team from 1 September *(routine, mildly dreading the form)*
> **Entry** — he opens her record from the org chart, not from an "HR transactions" menu *(no new mental model)*
> **Core action** — change org unit, set effective date 1 Sept, type one line of reason *(30 seconds)*
> ★ **Wow moment** — **Aisha gets a notification that says what changed, when it takes effect, who decided it, and why — in Rohan's own words.** She has never worked anywhere that told her that. The org chart shows her in both teams with a dated transition, so nothing is ambiguous on 31 August.
> **Close** — Meera's headcount is correct on 1 September without anyone touching a spreadsheet, and it was correct on 31 August too

The wow is not the form. It is that **a change to a person is communicated to that person, with a reason, by default.**

## Scope

| Version | Contents | Proves |
|---|---|---|
| **Thin slice** | Tenant + person + employment + effective-dated employment versions · org unit tree · create/view/change an employee with an effective date and a mandatory reason · own-record view with history · RLS tenant isolation · audit log | The data model is right and the transparency promise is real |
| **Recommended** ✅ | Thin slice **+** positions and vacancy · manager reporting line with dotted-line support · org chart UI · directory with field-level visibility · employee self-correction for factual fields · bulk import with per-row errors · the Rights Centre stub (view + export own data) | It survives a real 500-person tenant |
| **Everything asked for** | The above **+** custom fields · multi-entity/multi-country · position budgeting and headcount planning · workflow approvals on every change · matrix org modelling · org chart scenario planning | — |

**Recommended: the middle option.**

### Deliberately not doing, and why

- **Custom fields in v1.** Every HRMS drowns in these. We will find out which 3 fields customers actually add, then support those properly. Building a generic EAV custom-field system before we know is the single most reliable way to make every future query slow and every migration painful.
- **Approval workflows on employee changes.** Real requirement, wrong time. One hard-coded rule (manager changes need HR notification, not approval) until we have three concrete customer workflows to generalise from.
- **Matrix / dotted-line as a first-class org structure.** We support a secondary reporting line as an attribute. Full matrix modelling waits for a customer who genuinely has one.
- **Headcount planning and position budgeting.** This is a finance product wearing an HR hat. Later, or never.

## Markets and compliance cost

**Markets in scope: India and EU.** Applicable: DPDP Act 2023 + DPDP Rules 2025 `[LAW — VERIFY: phasing, per docs/05-compliance-catalog.md]`; GDPR. No AI in this feature, so `COMP-70`–`COMP-79` do not apply — **and that is recorded deliberately, not by omission.**

Compliance features **inside** this estimate, not deferred:

`COMP-01` classification metadata on every field (this is the module that establishes the pattern) · `COMP-20`/`COMP-21` own-record view and machine-readable export · `COMP-22` erasure propagation — the test must exist even though there is little to propagate to yet, because **it is the harness every later module plugs into** · `COMP-25` correction workflow with before/after audit · `COMP-30`/`COMP-31` retention config and purge job · `COMP-53` immutable audit covering sensitive reads · `SEC-02` tenant isolation via `FORCE ROW LEVEL SECURITY`.

**Deferred, dated, owned:** consent ledger UI (no consent-based processing in Core HR — employment legitimate-use basis applies `COMP-15`) → before the first attendance or biometric feature. Full Rights Centre (correction requests, erasure requests, grievance contact) → before the first paying enterprise tenant.

## Simplicity gate

**1. What does the complexity buy?** The only genuinely complex thing here is **effective dating**. It buys: correct payroll for mid-month changes, correct historical headcount, defensible audit, and retroactive corrections that produce arrears instead of silently rewriting the past. Without it, every one of those is impossible and adding it later means migrating every row. This complexity is bought and paid for.

**2. Simplest version delivering 80%?** A flat employee table with a `manager_id`. It delivers 80% of the demo and 0% of the payroll correctness. We are explicitly not shipping it. This is the one place where the simplest version is the wrong version, and saying so out loud is the point of this gate.

**3. Can Aisha complete the main action in under 10 seconds on her phone?** Her main action is *viewing* her record and its history — target under 2 seconds to interactive. Correcting a factual field: under 10 seconds.

**4. What did we leave out?** Listed above, with reasons.

## Risks and assumptions

- `[ASSUMPTION]` Most tenants have a single legal entity in one country. Multi-entity is a fast follower, and the schema must not make it impossible — but we do not build it now.
- `[ASSUMPTION]` Employees will correct their own factual data if allowed to. **Untested.** Cheapest experiment: ship it to one pilot tenant and count corrections in the first month.
- **Risk:** effective dating is conceptually hard and easy to implement subtly wrong. Mitigation: the Full-Stack agent writes the temporal model in `30-design-notes.md` and the Test agent asserts boundary dates before any UI exists.
- **Risk:** "the employee can edit their record" collides with "HR owns the record." Mitigation: a small, explicit list of self-correctable *factual* fields (preferred name, personal contact, emergency contact, pronouns). Never job, pay, manager, or dates.

## Adoption and launch

HR configures the org tree and imports employees — that is the one real setup cost, so bulk import with per-row error reporting is in scope, not a nice-to-have. Employees meet the product through the change notification, which is the wow moment, so **it must be excellent before launch, not after**. Managers meet it through the org chart.

The one-line answer to "why should I care": *"Your record is finally yours — you can see it, see who changed it and why, and fix what's wrong."*

## Open questions

- **Q-01 → BA:** can an employee have two concurrent employments in one tenant (a genuine dual role)? Assumed **no** for v1; rehire creates a new employment. Not blocking.
- **Q-02 → BA:** on rehire, is the person record reused? Assumed **yes** — one `person`, many `employment` rows. This matters for tenure calculations later. Not blocking, but decide before positions.
- **Q-03 → Full-Stack:** do we need full bitemporality (valid time *and* system time as intervals) in v1, or is append-only versioning with `recorded_at` sufficient? **Blocking the schema.**

## Handoff

**To:** hrms-business-analyst
**Ready:** yes
**Blocking:** Q-03 must be resolved with the Full-Stack agent before the schema is written.
**Assumptions to challenge:** single legal entity · employees will self-correct · dotted-line as an attribute rather than a structure.

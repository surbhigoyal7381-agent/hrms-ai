---
feature: 002-employee-self-service-record-view
artefact: opportunity
author: hrms-product-manager
date: 2026-08-25
status: draft
inputs: [docs/features/001-core-hr-foundation/10-opportunity.md, docs/features/001-core-hr-foundation/20-requirements.md, docs/features/001-core-hr-foundation/50-review.md, docs/features/001-core-hr-foundation/99-decision-log.md, docs/07-fairness-and-transparency.md, docs/03-nfr-catalog.md, docs/05-compliance-catalog.md]
---

# My record — what the company holds about me, and who has looked at it

Feature 001 built the floor: bitemporal employment history, a transparency ledger, an audit log with a
`sensitive_read` flag, RLS on every table. **Nothing shows any of it to the person it is about.**
There is no `apps/web`, no HTTP API, no screen. REQ-005, REQ-006, REQ-007 and REQ-009 were specified
and not implemented.

This is the first feature an actual employee can open. It is therefore the first real test of the
ten-second employee action bet in `CLAUDE.md` §5, and the moment the Transparency Ledger stops being
a table and becomes the product.

> **Revised 2026-08-25 on a human decision.** Availability of this feature is now an **organisation
> (tenant) setting, OFF by default.** That changes who ever sees the wow moment, what the north-star
> metric can honestly measure, and — the part that needs a decision before build — whether the
> right-of-access and export path can sit behind the switch at all. See **The organisation setting**
> below. The decision itself is not re-argued here; its consequences are recorded, because that is
> what this brief is for.

## The problem, as a story

Aisha, in her own words:

> "In March I got moved to Payments. I found out because my Slack channels changed. Nobody told me
> the date, and when payroll paid me in April I could not tell whether the transfer was in the system
> yet or not.
>
> In June I asked HR to fix my personal phone number — the old one is still on my record and I have
> not had that SIM since 2024. Meera said she would raise it. I do not know if she did. I cannot see
> my own record to check.
>
> In July a friend in another team resigned. She told me her manager had known she was on a list of
> people HR was 'reviewing' for two months before she did. I do not think that happened to me. But I
> have no way to know, and now I think about it more than I would like to."

Three separate failures, one cause: **Aisha's record is something done to her, that she cannot see.**

The concrete consequence: Aisha's emergency contact is her ex-partner, three years out of date. Nobody
will discover that until the day it matters.

## Who is affected, how often, at what cost

| Persona | Frequency | Cost today |
|---|---|---|
| **Aisha** (employee) | Every time something changes about her, plus a background hum of not knowing | An HR ticket per correction; stale data she cannot fix; low-grade distrust |
| **Meera** (HRBP) | Daily | Fields a ticket queue of "please update my address" that no HRBP should be touching |
| **Sunil** (payroll) | Every cycle | A wrong personal email means a bounced payslip and a manual re-send |
| **Rohan** (manager) | Per change | Explains transfers himself because the system told nobody |
| **Dev** (IT) | At audit | Cannot demonstrate a subject-access route that is not a mailbox |
| **Priya** (CHRO) | Once, at the start | **New:** she now has to make a decision — switch this on or leave it off. That decision is the feature's entire funnel |

`[ASSUMPTION]` We have no baseline for HR-ticket volume of the "fix my details" type. **Measuring it in
the pilot tenant during the first two weeks is task one**, before the setting is switched on.

**What breaks in six months if we do nothing:** everything else we build lands in a product no employee
has ever voluntarily opened. Leave, payslips and recognition all assume a person who already trusts the
app enough to log in. That trust has to be built by something, and this is the cheapest something we have.

## Pillar and metric this moves

**Primary pillar: Transparency** — "people can see the things that affect them".

The metric is restated under **Success metrics** below, because the tenant setting changed its
denominator and it would be dishonest to leave the old number standing.

## What competitors do

Verified this session where marked. Everything else is `[UNVERIFIED]` and must not go into sales material.

| Product | What it does with the employee's own record | Confidence |
|---|---|---|
| **Workday** | Always-on audit trail: business-process, configuration and security changes logged with who, when, and before/after values, reachable from an object via "View Audit Trail". Access is governed by delivered security roles, including **audit roles for HR and Finance** — it is built for auditors and administrators, not addressed to the employee. | Verified (vendor + practitioner docs) |
| **BambooHR** | An employee edits a field, saves, and the change goes to an **approver** who is emailed. Change history is documented for timesheets. Whether a general profile-field change log is shown to the employee is not documented publicly. | First half verified; second half `[UNVERIFIED]` |
| **HiBob** | An **Audit / Changes Report** exists covering any change to any field across company history, with changed-by and before/after values. Permissions are role-scoped on people-scope and data-scope, with field-level visibility per role. Which roles see the audit report by default is not documented publicly. | First half verified; default audience `[UNVERIFIED]` |
| **Keka** | Employees update their profile through the ESS portal, and **most profile updates route to an approval**; admins configure per field who can view, who can update, and whether approval is needed. | Verified (vendor help centre) |
| **Darwinbox** | Not checked this session. `[UNVERIFIED]` | — |

**Table stakes** — a profile page, a photo, editable personal contact fields, a change request that
reaches HR. We must have these or we look broken. We win nothing with them.

**Where everyone is weak** — the audit trail exists in all of these products and is **pointed at the
administrator**. It answers "prove to the auditor what changed". None of the documentation checked this
session shows a product that turns to the employee and says *here is your history, and here is who opened
your file*. The `sensitive_read` half — **who looked** — is the part nobody surfaces.

Note for the "our angle" claim below: **every one of these products is configurable by the administrator,
and so is ours now.** Our differentiator is no longer "we show it and they do not." It is "we show it by
one switch, and the switch is visible" — which is a materially weaker claim, and the brief should say so
rather than keep the old sentence.

## Our angle

**One sentence:** we make it possible for an employer to show Aisha the audit log that every other HRMS
keeps and shows only to auditors.

Defensible? Not technically — it is one screen over data these products already hold. It is defensible as
**positioning**, and the positioning is now conditional on the customer choosing it. That is a real
weakening and it is recorded as one. Treat it as a head start, not a moat, and test whether customers
actually turn it on — see kill criterion 1.

## The organisation setting

**The decision, as given:** whether this feature is available at all is an organisation (tenant) setting.
It is **OFF by default** — out of the box, in a brand-new tenant, no employee can open My record. **HR
keeps access to that person's record by default.**

### Does "HR keeps access" change anything? No — and being precise matters

Checked against the `docs/07-fairness-and-transparency.md` Part 2 matrix, row by row, for the rows this
feature touches: *own profile, role, org position* → HR ✅. *Who decided it, and when* → HR ✅. *Who has
viewed their sensitive data* → HR ✅. **HR already holds a tick on every relevant row. No row moves. This
clause is a restatement of the existing default, not a change**, and I will not claim a change that is
not there.

Two things it does usefully pin down:

1. **The switch governs the employee's view only.** Off means Aisha cannot see it; HR still can. The
   asymmetry is deliberate, and it should be stated in the UI rather than discovered.
2. **"HR *of that person*"** implies HR access scoped to the people an HRBP is responsible for, rather
   than tenant-wide. Feature 001's permissions matrix has a single, unscoped "HR admin" column, and this
   feature builds **no HR-facing screen at all**, so nothing changes in this slice. But scoped HR becomes
   a real requirement the moment an HR console exists. → **Q-07**, not blocking here.

### The tension, stated plainly

Part 2 says: *"Tenant admins may restrict these further."* **A tenant switching this off is expressly
permitted by the charter.** That half is not in tension with anything.

The **default** is the part in tension. Part 2's rule is *"Default to showing a person everything that is
about them"*, and `CLAUDE.md` §2 truth 3 is *"Transparency by default, privacy by design."* **A
default-off switch inverts both.** It is the human's decision, it is not on the refuse-to-build list, and
it is recorded here as a deliberate deviation from the charter's default — not an oversight, and not
something a later reader should have to reconstruct.

Part 2 also requires that a change **in the more-visible direction** be *"an explicit, logged, in-product
decision that employees are notified of."* The mirror case — an admin switching this **on**, or later
switching it **off** — is not covered by that sentence.

**Recommendation: log and notify in both directions.** Switching on: employees are told the screen now
exists, which doubles as the adoption mechanism. Switching off: employees are told it has been withdrawn,
when, and by whom. An organisation that removes a transparency surface silently is doing the thing the
charter exists to prevent; an organisation that removes it openly has made a decision it can defend.
→ **Q-04**, recommend yes.

### Permanent policy switch, or staged-rollout flag?

These are different products, and the instruction did not say which.

| | Rollout flag | Policy switch |
|---|---|---|
| Lifetime | Temporary | Permanent |
| Why it is off | The feature is new | The customer chose |
| Expected end state | Every tenant on; the default flips at a dated GA | Some tenants stay off forever |
| What we tell a customer | "Coming to you on a date we name" | "Your call, permanently" |

*"OFF by default, out of the box, in a new tenant"* describes a **policy switch** — a rollout flag would
not survive GA. **I am specifying a permanent tenant policy switch.** Mechanically both are the
Postgres-backed flag behind an OpenFeature interface that `CLAUDE.md` §7 already sanctions; the difference
is product intent, and it changes the sales conversation and whether this file needs a GA date.
→ **Q-05, for the human.** If the answer is "rollout flag", a dated default-flip belongs in this brief.

### One switch, no granularity

One tenant-level on/off. **No** per-field, per-department, per-employee or per-role granularity, and no
employee-facing toggle. If a customer asks for "history yes, access log no", that is a second setting, and
we do not build it until a second customer asks (`docs/02-definition-of-done.md` §Gate 0, the
configuration-screen smell).

### The compliance consequence — the part that needs a decision, not a default

`COMP-20` (see, export, correct your own data) and `COMP-21` (machine-readable complete export) are
**statutory rights of the data principal / data subject, not features a customer buys.** If the entire
feature sits behind the switch, then in a default configuration **this product serves no right-of-access
path at all** — there is no HR admin UI, no DSAR workflow, and no export anywhere else in the product. A
new tenant would ship with `COMP-20` and `COMP-21` unserved.

Both halves of the honest picture:

- The right of access is an obligation of the **employer as controller**, not of us as processor. An
  employer could in principle satisfy a request by email and a spreadsheet, outside our product. So a
  default-off switch does not, by itself, put anyone in breach.
  `[LAW — VERIFY: whether the DPDP Act 2023 / DPDP Rules 2025 and GDPR Arts. 15 and 20 permit a controller
  to satisfy access and portability outside the processor's system, and what response clock applies —
  unverified, as of 2026-08-25]`
- But **our own catalogue's `COMP-20` says the Rights Centre is "Not an email address. Not an HR ticket."**
  And `CLAUDE.md` §6 says build for the strictest applicable rule, then relax per tenant by configuration.
  Both cut toward a carve-out.

**My recommendation: carve the right-of-access path out of the switch.**

| Always available, not switchable | Behind the tenant switch |
|---|---|
| **Download my data** (`COMP-21`) | The change history, with reasons and deciders |
| A minimal view of the fields the tenant already holds about Aisha | ★ **The access log — who looked, when, and why** |
| The published DPO / grievance contact (`COMP-06`) | Self-correction of the six allowlisted fields |

**Reasoning, in one line:** a tenant may reasonably decide how much of its internal decision-making it
narrates to employees; it should not be able to switch off a person's statutory right by leaving a default
alone.

**This is not mine to decide alone.** → **Q-06 — BLOCKING, for the human and for counsel.** If the answer
is "no carve-out, everything sits behind the switch", then this brief needs a named alternative
right-of-access path, with an owner and a date, before the feature ships — because otherwise we are
selling a product that cannot answer a lawful request in its default state, and that is a sentence someone
will one day read back to us.

## The experience spine

> **Step zero — new** — Priya switches My record on for the organisation. The change is logged and every
> employee is notified that the screen now exists *(Q-04)*
> **Trigger** — Aisha learns her transfer to Payments takes effect 1 September *(curious, slightly wary)*
> **Entry** — one tap straight to My record. No menu, no "Employee Self-Service" hub *(`UX-01`)*
> **Core action** — she reads: current values at the top; below them every change with **what, when, who
> decided, and why in Rohan's own words**; the 1 September change sits at the top labelled **"takes effect
> in 7 days"** (feature 001, decision Q-04) *(reassured — she was told before it happened)*
> ★ **WOW MOMENT** — she scrolls to **"Who has looked at your record"** and reads: *"Meera Nair, HR
> Business Partner — opened your record on 14 Aug 2026. Reason: annual pay review."* She has worked in
> three companies and no HR system has ever volunteered that. **This is the sentence she reads out to a
> colleague at lunch.**
> **Core action 2** — she taps her personal phone number, types the new one, saves. It is hers, so no
> approval, no ticket, no Meera *(`COMP-25`, two taps, instant)*
> **Close** — she taps **Download my data** and gets a JSON file with everything above *(`COMP-21`)*

**Exactly one wow.** It is not the profile page. It is the access log.

### What the wow moment is now, and to whom — honestly

**Unchanged in kind, changed in reach. In a default-configured tenant it happens for nobody.** The wow now
depends entirely on the tenant opting in. That is the honest sentence, and I am not going to soften it.

**What is this feature for in a default tenant?** With the carve-out I recommend: **exactly one thing —
Aisha can download her own data.** That is a compliance floor, not a wow, and dressing it up as one would
be the kind of claim this brief exists to prevent. Without the carve-out: nothing. The feature is dormant
code behind a login screen.

**What that changes about how we judge this feature.** The main risk used to be *"will employees find the
access log alarming?"* It is now *"will any tenant turn it on?"* Those are answered by different numbers.
Step zero is now the whole funnel, and the metrics below are restated accordingly.

## Scope

| Version | Contents | Proves | Rough size |
|---|---|---|---|
| **Thin slice** | `apps/web` + authenticated session + one read-only route, **gated by the tenant setting and fail-closed when the setting is unset**. Current values · full change history with reason and decider · future-dated changes labelled · **who has looked at your record** · the "some things are not shown, and here is why" panel · every read writes a `sensitive_read` audit entry | Whether the access log lands or alarms, **in a tenant that opted in** | days |
| **Recommended** ✅ | Thin slice **+** the tenant setting itself: off by default, one admin control, **the flip logged and employees notified in both directions** (Q-04) **+** the always-available export carve-out, pending Q-06 **+** self-correction of the six allowlisted fields with a **server-side enforcing function** (closes the open MINOR from 001) **+** Download my data (JSON, `COMP-21`) **+** the events under Success metrics **+** the DPO/grievance contact in-product (`COMP-06`) **+** mobile-first at 360px, keyboard-complete, axe-clean | That it survives real use by 400 people — **and that a customer will switch it on** | weeks |
| **Everything asked for** | The above **+** directory and org chart (REQ-007) · HR admin UI for creating and changing employees (REQ-002) · bulk import (REQ-008) · correction *requests* for locked fields with a response clock · change notifications (needs a queue) · document vault · manager view of the team · full Rights Centre (erasure request, consent withdrawal) · native mobile app | — | — |

**Recommended: the middle option.** It is roughly a third of "employee self-service" as normally
understood, and it is one person doing one whole job end to end (product truth 7).

### Deliberately not building in this slice, and why

- **Granularity on the setting.** One tenant-level on/off, as above. No per-field or per-group variants,
  and no employee-facing toggle.
- **An organisation-settings console.** The switch is one control in whatever admin surface exists. We are
  not building a settings section to hold a single toggle.
- **The directory and org chart.** They are about *other people* — a different trust problem, and the
  directory needs the field-level visibility matrix, an export throttle and an alert (`SEC-10`, `COMP-60`).
- **Any HR-facing admin UI.** HR changes go through the existing domain functions from 001 and seeded
  data. Build the HR console first and we will have built an HR product — `CLAUDE.md` §2, truth 1.
- **Correction *requests* for locked fields** (job title, manager, pay, dates). Six self-correctable fields
  cover the common case. A request queue needs a response clock (`COMP-24`), an approver and a
  notification. **Until it exists, the UI must name who to contact instead of showing a dead end (`UX-04`).**
- **Change notifications by email or push** — beyond the one required by Q-04 for the setting itself. There
  is no queue and no notification service; the toggle notice is the minimum, not the start of a platform.
- **Bulk import, documents, the full Rights Centre.** Named, deferred and dated below.
- **Any AI.** No model call in this feature. Recorded deliberately, not by omission: `COMP-70`–`COMP-79`
  do not apply.

## Markets and compliance cost

**Markets: India and EU** (the two deployment regions in `CLAUDE.md` §7). No new data store, no new
sub-processor and no cross-border transfer is introduced, so `COMP-40`/`COMP-43` residency is inherited
from 001 rather than re-litigated, and `COMP-04` gains no entry.

**In the estimate, not deferred:** `COMP-20` — this screen is the first half of the Rights Centre,
**subject to Q-06 on whether any of it may sit behind the tenant switch** · `COMP-21` machine-readable
complete export including derived values · `COMP-25` correction with before/after audit · `COMP-53` the
sensitive-read audit that feeds the access log, and **every new HTTP read path writes one whether or not
the setting is on** — the audit does not depend on who is allowed to read it · `COMP-06` DPO/grievance
contact published in-product · `COMP-23` if a legal hold exists on Aisha she is told it exists where the
law permits `[LAW — VERIFY: whether DPDP Act 2023 and GDPR Art. 15 permit or require informing a data
subject that a litigation hold exists, per market — unverified, as of 2026-08-25]` · `SEC-01` server-side
authorisation on every endpoint, **the tenant setting included — off must mean 403, never a hidden nav
item** · `SEC-10` rate limit on the export endpoint · `PERF-01` · `A11Y-01`–`A11Y-05` · `PRIV-07` no PII
in logs or events.

**Deferred — dated and owned:**

| Deferred | By when | Owner |
|---|---|---|
| Correction requests for locked fields, with response clocks (`COMP-24`) | feature 003 | PM |
| Erasure request and consent withdrawal in the Rights Centre (`COMP-12`, `COMP-22` user-facing) | before the first paying enterprise tenant | PM |
| Retention purge job actually running (`COMP-31`) — carried from 001 | before the first tenant with an ex-employee past the statutory window | Full-Stack |
| Scoped HR ("HR *of that person*") rather than tenant-wide HR admin | with the first HR-facing screen | BA |

## Simplicity gate (`docs/02-definition-of-done.md` §Gate 0)

1. **What does the complexity buy?** Two things. The **transport layer** buys the existence of a user
   interface; there is no cheaper version of that. The **tenant setting** buys customers who would
   otherwise not deploy the feature at all — that is the human's judgement, recorded as theirs, and it is
   a legitimate answer to this question even though it costs us the default.
2. **What is the simplest version delivering 80%?** A read-only profile page with no history and no access
   log. It delivers 80% of the *screens* and 0% of the differentiator, and it is what every competitor
   already ships. We are explicitly not shipping it.
3. **Can Aisha complete the main action in under 10 seconds on her phone?** Her main action is *reading* —
   interactive under 2s on a mid-range Android over 4G (`PERF-01`). Correcting her phone number: under 10s.
4. **What did we deliberately leave out?** The list above, with reasons — and the setting's granularity is
   on it.

## Success metrics

The old north star — *share of employees who open My record twice in 30 days* — no longer has an honest
denominator, because most employees are now in tenants where the screen does not exist. It is replaced by
**two required numbers, reported together.**

**1. Tenant activation (new, and now the leading indicator).**
*Share of pilot tenants that switch My record ON within 60 days of being offered it.*
Baseline 0. Target: **3 of the first 5 pilot tenants.** With the setting off, the employee metric has no
population to measure, so this number gates the other one.

**2. North star (same shape, restated denominator).**
*Share of employees **in tenants where the setting is ON** who open My record at least twice within 30 days
of the switch being flipped.* Baseline 0. Target **40%**.
**Always reported with the denominator attached** — "40% of 1,180 employees, across 3 of 5 tenants" — never
as a bare percentage. One enthusiastic tenant can otherwise make a dormant product look healthy.

**3. Deactivations.** Count of tenants that switch it on and then off again, **with the recorded reason
from Q-04's log.** A small number is information. Any at all is a conversation with that account.

**Secondary:** "please correct my details" HR tickets per 100 employees per month, in ON tenants → down.

**Guardrails, must not get worse:** zero cross-tenant exposure (not a trade-off) · **the setting is
honoured server-side — with it off the gated endpoints return 403** · p95 server < 800ms and interactive
< 2s (`PERF-01`) · no field appears that the Part 2 visibility matrix hides · zero dropped `sensitive_read`
audit writes — a partial access log is worse than none.

**Counter-metric: distress.** Grievances or HR queries *caused by* the access log, per 100 viewers. If
people leave that screen frightened, the feature is failing while the north star looks healthy. Second
counter-metric: export downloads high and repeat visits low — that means we shipped a compliance screen,
not a product.

**Events the product must emit** (`OBS-03`; these become BA requirements, no PII in any payload):
`tenant_record_view_setting_changed{from, to, actor, reason}` · `record_view_blocked_by_tenant_setting` ·
`own_record_viewed` · `record_history_expanded` · `future_dated_change_shown` · `access_log_viewed` ·
`access_log_scrolled_past_first_entry` · `hidden_data_explainer_opened` · `self_correction_saved{field}` ·
`self_correction_rejected{field, reason}` · `data_export_requested` · `dpo_contact_opened`.
**The export and DPO events must fire regardless of the switch** — they are the carve-out's evidence.

## Kill criteria

1. **New, and now first.** If **fewer than 2 of the first 5 pilot tenants** switch it on within 60 days,
   the bet in `CLAUDE.md` §5 — that transparency is what customers want to buy — is wrong *at the point of
   sale*. We stop building transparency surfaces until we understand why. **That is a bigger finding than
   this feature**, and it should go to the human, not into a backlog.
2. If, 60 days after switch-on, **fewer than 15%** of employees in ON tenants have opened My record twice,
   we stop adding to it and re-examine the premise rather than adding a dashboard.
3. If the access log produces more grievances than positive feedback in that window, **the access log goes
   off by tenant flag** and we redesign how it is presented. The underlying audit is never deleted.

## Risks and assumptions

- ★ **Risk — the setting becomes the thing customers use to keep employees in the dark.** A buyer signs on
  the transparency pitch, then leaves the switch off so nobody sees who read their file. The feature then
  exists to win the deal rather than to serve Aisha, which is the exact inversion `CLAUDE.md` §1 says we
  are not building.
  **How we would know:** metric 1 (tenant activation) is the blunt signal. The sharp one is the
  **cross-reference between the sales narrative and the setting state** — a tenant that bought on
  transparency and is 60 days live with the switch off is a **named account, not a statistic.** Ask them
  why, record the answer in the Q-04 log, and put the collected reasons in front of the human each quarter.
  **If the common reason turns out to be "our HR team did not want employees seeing the access log", that
  is the product finding**, and it belongs in a charter review (`docs/07-fairness-and-transparency.md`
  Part 5), not in a backlog.
- **Risk — Aisha cannot tell "there is nothing to show" from "your employer turned this off."** Part 2 is
  explicit that a visible *"this is hidden, and here is why"* builds more trust than a screen pretending
  nothing is missing. If the carve-out lands, an employee in an OFF tenant sees a working download page,
  and it should say plainly which parts of the record view her organisation has turned off.
  `[ASSUMPTION]` some tenants will object to that line existing at all. **That objection is exactly the
  thing to settle now rather than after launch.** → **Q-08**, recommend showing it.
- ★ **Risk — the access log surfaces something distressing.** Aisha opens it and sees that HR viewed her
  record 14 times last month. She concludes she is being managed out. She may be right; she is more likely
  wrong. **This is the wow moment and the biggest employee-facing risk in the same screen.** Mitigations,
  all in scope: show the **purpose** next to every access, never a bare count ("payroll run, August cycle"
  · "annual pay review") · separate automated system reads from human reads, so a nightly job does not read
  as surveillance · never render a total-count badge · give a next step rather than a dead end (`UX-04`):
  an "Ask about this" route reaching the DPO/grievance contact (`COMP-06`).
  **`[ASSUMPTION]` a purpose is derivable from the calling code path — the BA must confirm what the audit
  log actually records before this is promised in the UI.**
- **Risk — the promise is bigger than the data.** "This is everyone who looked" is false if any read path
  does not write an audit entry, or if an engineer queries the database directly. A transparency feature
  that overstates is worse than none. The screen must say exactly what it covers — *access through
  Thrive* — and every new endpoint here writes its entry.
- **Risk — case-handler exposure.** Part 2 and `docs/05-compliance-catalog.md` §3 both require complainant
  protection from access-log exposure. A POSH respondent must not learn from the access log that an
  investigator opened his file. **Suppression alone is not enough: a line that appears only when it applies
  is itself a signal.** The standing "some authorised access is not listed, and here is why" panel must be
  shown to everyone, always. → **Q-02, blocking.**
- **Risk — a default-off feature rots.** Nobody uses it, nobody notices when it breaks, and it decays
  between releases. Mitigation: the pilot tenants are on. If none are, kill criterion 1 has already fired.
- **Risk — the `app.tenant_id` GUC.** 001 accepted this as open debt: the app role can set the GUC freely,
  so any SQL-injection defect escalates to a full cross-tenant breach. **Until this feature there was no
  HTTP endpoint to inject into.** The debt goes from theoretical to reachable on the day this ships. Fixing
  it is not this brief's call; saying it out loud is. → raise with the Full-Stack agent.
- **Open MINOR from 001 that this feature must close:** `SELF_CORRECTABLE` is an allowlist with no
  enforcing function. REQ-006 requires a 403 at the API, never a hidden field in the UI.
- `[ASSUMPTION]` Employees will self-correct if allowed to. Still untested, carried forward from 001.
- `[ASSUMPTION]` A tenant that switches this on wants every employee to have it, not a subset. If that is
  wrong we will hear it as a request for granularity, and the answer is the second-customer rule.

**Cheapest experiment, and it now has two halves:**

1. **Will a customer turn it on?** Ask three pilot CHROs, before we build the screen, one question: *"If
   this existed and was off by default, would you switch it on, and what would stop you?"* Half a day, and
   it de-risks the whole feature more than any amount of UI work.
2. **Is the wow a wow or an alarm?** Ask the pilot tenant's HR to pull the real access history for **10
   volunteers** and show each person their own, on paper, in a five-minute conversation. Record the first
   sentence out of their mouth. One day of work.

## Open questions

| # | To | Question | My assumption / recommendation | Blocking? |
|---|---|---|---|---|
| **Q-01** | BA | Aisha's own visit writes a `sensitive_read` entry. Is it excluded from her access log, or shown as "you"? | **Shown as "you"** — a log with silent exclusions is not a log | No |
| **Q-02** | BA + legal | Exact wording of the standing suppression panel for confidential-case access, and when it appears | Always shown, to everyone | **Yes** |
| **Q-03** | BA | How far back does the access log go? REQ-005 says 12 months | Confirm against audit retention config (`COMP-30`) so the screen never promises more than the data holds | No |
| **Q-04** | Human | Is an admin flipping the setting logged, and are employees notified — **in both directions**? | **Yes, both directions.** Mirrors Part 2's requirement for the more-visible direction | No — but decide before build, it is in the scope table |
| **Q-05** | Human | Permanent tenant **policy switch**, or temporary **staged-rollout flag**? The instruction did not say | **Policy switch.** If it is a rollout flag, this brief needs a dated default-flip | **Yes** — it changes what we tell customers and what the BA specifies |
| **Q-06** | Human + counsel | Must the right-of-access and export path (`COMP-20`, `COMP-21`) be carved out of the switch and always available? **There is no other DSAR path anywhere in this product.** | **Carve it out.** A tenant may decide how much it narrates; it should not switch off a statutory right by leaving a default alone. `[LAW — VERIFY: DPDP Act 2023 / DPDP Rules 2025 and GDPR Arts. 15, 20 — unverified, as of 2026-08-25]` | **Yes — the biggest one** |
| **Q-07** | BA | "HR *of that person*" implies scoped HR; 001 has one unscoped HR admin column | No change in this slice (no HR screen); becomes real with the first HR console | No |
| **Q-08** | Human | In an OFF tenant, does the product tell Aisha that her employer has turned the record view off? | **Yes** — Part 2 says a visible "this is hidden, and here is why" beats a screen pretending nothing is missing | No, but it is a values question, not a UI question |

## Adoption and launch

**The funnel now starts one step earlier, and that is the whole change.** Previously HR had to configure
nothing. Now somebody has to switch it on, and if nobody does, none of the rest of this plan happens.

**Who decides:** Priya (CHRO), not Dev (IT). This is a statement about how the company treats people, and
it should be taken by the person who can defend it, not by whoever administers the tenant.

**How we ask for the decision:** at onboarding, one plainly-worded choice with both consequences written
out — what employees will see if it is on, what they will not see if it is off. **No pre-ticked box, no
manufactured urgency, no "recommended" badge doing the persuading for us** (`docs/07` Part 3, dark
patterns). If we cannot win this on the argument, we should not win it on the interface.

**Who announces it to employees:** the CHRO, at switch-on, via the Q-04 notification. That notification is
now both a charter obligation and the entire adoption mechanism — **it must be excellent before launch,
not after.**

**In-product introduction:** one card on first login after switch-on. *"This is your record. You can see
everything in it, every change ever made, and who has looked at it."* No tour, no chain of modals.

**What HR must configure first:** one switch. Nothing else. If this ever needs a configuration project it
will not get adopted.

**What could make HR and managers resist:** HR will worry that the access log makes routine work look
sinister — a real concern, and purpose-labelling is the answer. Brief HRBPs before launch and show them
**their own** access log first, so they meet it as a subject rather than as a target. Managers are
unaffected: per feature 001 decision Q-05 they do not see who viewed their team's records, and saying so
up front prevents the question.

**The one-line answer to "why should I care":** *"You can finally see your own file — what's in it, every
change, and who's been reading it."*

## Handoff

**To:** hrms-business-analyst
**Ready:** yes, with two blocking questions that are not yours to answer

**The change you most need to know about:** availability of this whole feature is an **organisation
(tenant) setting, OFF by default**. A brand-new tenant has it off and no employee can open My record. HR's
access to that person's record is unaffected — checked against the Part 2 matrix, **no row moves; that
clause restates the existing default.** The switch gates the employee's view only, and it must be enforced
server-side: off means 403, never a hidden nav item.

**Open questions blocking you:**
- **Q-06** — the `COMP-20`/`COMP-21` carve-out. Until a human and counsel answer this, you cannot specify
  whether "Download my data" is reachable in a default tenant, and that changes the permissions matrix,
  the acceptance criteria and the compliance section of your requirements.
- **Q-05** — policy switch or rollout flag. It changes what the setting is called, what we tell customers,
  and whether a dated default-flip exists.
- **Q-02** — the confidential-case suppression panel needs wording agreed with legal before the access log
  can be specified.

**Open questions not blocking you:** Q-01 (own visits in own log), Q-03 (access-log window vs audit
retention), Q-04 (log and notify on both flips — my recommendation is yes and it is in the scope table),
Q-07 (scoped HR), Q-08 (telling employees the setting is off).

**Assumptions I made that you should challenge:**

1. That a **purpose** can be derived for every audit entry. If it cannot, the wow moment degrades to a bare
   list of names and dates, which is closer to alarming than reassuring — tell me early, it changes scope.
2. That six self-correctable fields are enough for v1 and a request queue can wait.
3. That the directory can be cut from "employee self-service" without the slice feeling incomplete.
4. That no notification is needed in this slice **beyond the Q-04 setting notice**. I think this is the
   weakest of the four.
5. That one tenant-level on/off is enough granularity, and the first request for per-field control gets
   the second-customer rule rather than a build.

**Also carry forward:** the `SELF_CORRECTABLE` enforcing function (open MINOR from 001) is in this
feature's scope; and the `app.tenant_id` GUC risk becomes reachable the day a public endpoint exists —
raise it with the Full-Stack agent in `99-decision-log.md` rather than assuming someone else has.

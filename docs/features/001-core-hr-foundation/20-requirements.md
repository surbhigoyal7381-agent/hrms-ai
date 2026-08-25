---
feature: 001-core-hr-foundation
artefact: requirements
author: hrms-business-analyst
date: 2026-08-24
status: draft
inputs: [10-opportunity.md]
---

# Requirements — Core HR foundation

## Answers to the PM's open questions

- **Q-01 — concurrent employments?** No, not in v1. One active `employment` per `person` per `tenant`. A genuine dual role is modelled as one employment with a secondary reporting line.
- **Q-02 — rehire reuses the person?** Yes. One `person`, many `employment` rows. Tenure is computed per employment; "total tenure" sums them and is a **separate, named** number — the two get confused constantly and the UI must label which one it is showing.
- **Q-03 — bitemporal?** Resolved with the Full-Stack agent: **append-only versioning with `valid_from` / `valid_to` (business time) plus `recorded_at` (system time), never UPDATE, never DELETE.** This answers "what is true on date X" and "what did we know at time T" for every row that exists. Full interval-bitemporality is deferred; the trigger for revisiting is the first payroll run that must be reproduced exactly after a retroactive change. Recorded in `99-decision-log.md`.

## Scope

**In:** tenant · person · employment · effective-dated employment attributes · org unit tree · positions and vacancy · reporting lines (primary + secondary) · directory · org chart · own-record view with history · employee self-correction of factual fields · bulk import · audit log · transparency ledger · data export.

**Out (v1):** custom fields · approval workflows · multi-entity/multi-country · headcount planning · matrix org as a structure · payroll · leave · documents.

---

## Part 1 — The temporal model

Everything else depends on getting this right, so it is specified first.

### RULE-001 — Effective-dated attributes

Employment attributes that affect pay, reporting, or headcount are stored as **append-only versions**. A version is valid over a half-open business-date interval `[valid_from, valid_to)`.

- `valid_from` — the business date the change takes effect. **A date, not a timestamp.**
- `valid_to` — exclusive end. `NULL` means "still current".
- `recorded_at` — the timestamp we learned it. Set by the system, never by a user.
- Rows are **never updated and never deleted.** Correcting a mistake appends a correcting version.

**Worked example — a transfer**

Aisha is in Engineering. On 22 Aug, Rohan moves her to Payments effective 1 Sept.

| id | valid_from | valid_to | org_unit | recorded_at |
|---|---|---|---|---|
| v1 | 2023-04-01 | **2026-09-01** | Engineering | 2023-04-01T09:00Z |
| v2 | **2026-09-01** | NULL | Payments | 2026-08-22T14:32Z |

- "Where is Aisha on 31 Aug 2026?" → Engineering (31 Aug < 2026-09-01)
- "Where is Aisha on 1 Sept 2026?" → Payments (half-open interval: `valid_from <= d AND (valid_to IS NULL OR valid_to > d)`)
- "What did we believe on 20 Aug?" → filter `recorded_at <= '2026-08-20'` → only v1 existed, so Engineering, indefinitely. Correct.

**Boundary example — same-day change.** Two changes effective the same date: the later `recorded_at` wins; the earlier version is closed with `valid_to = valid_from` producing a **zero-length interval**, which must never be returned by a point-in-time query. Test explicitly.

**The nasty one — retroactive change.** On 15 Sept, HR is told the transfer actually happened on 15 Aug. We do **not** edit v2. We append v3 `[2026-08-15, NULL)` and close v2 at `2026-08-15`, leaving v2 with a zero-length interval — it is now historically superseded but still visible in the ledger. Anything already computed from the old dates (a payroll run, a headcount report) must be recomputed, and **the fact that it changed after the fact is itself shown in the transparency ledger.** Silent retroactive rewriting is exactly what this model exists to prevent.

### RULE-002 — Point-in-time query

```
valid_from <= :as_of AND (valid_to IS NULL OR valid_to > :as_of) AND valid_from < valid_to
```

The last clause excludes zero-length superseded intervals. **Omitting it is the bug this rule exists to prevent** — it returns two rows for one person and every downstream count doubles.

### RULE-003 — What is effective-dated and what is not

| Effective-dated (append version) | Not dated (correct in place, with audit) |
|---|---|
| org unit · position · job title · primary manager · secondary manager · employment type · work location · cost centre | preferred name · personal email · personal phone · emergency contact · pronouns · profile photo |

The split is: **anything that changes a historical fact about the organisation** is dated. **Anything that is a current fact about the person** is corrected. Aisha's phone number in 2024 is not a fact anyone needs; her manager in 2024 is.

Legal name is the awkward one. **Decision: legal name is corrected in place, with full audit history retained.** A name change is not a business-date event, and treating it as one produces payslips addressed to a name the person has rejected. `[LAW — VERIFY: some statutory filings may require historical legal name; confirm before payroll.]`

---

## Part 2 — Data specification

Classification drives `COMP-01`, retention, permissions, export and erasure. **Every column carries it.**

### `person` — the human

| Field | Type | Req | Validation | Class | Read | Write |
|---|---|---|---|---|---|---|
| `id` | uuid | y | — | internal | all | system |
| `legal_name` | text ≤200 | y | non-empty after trim; no structure assumed (`I18N-03`) | identity | self, mgr, HR | HR, self (request) |
| `preferred_name` | text ≤100 | n | — | identity | everyone | **self** |
| `pronouns` | text ≤50 | n | free text, never a fixed list | identity | everyone | **self** |
| `date_of_birth` | date | n | ≥16 yrs ago; not future | identity | self, HR | HR |
| `personal_email` | citext | n | RFC-valid | identity | self, HR | **self** |
| `personal_phone` | text | n | E.164 | identity | self, HR | **self** |
| `national_id_ref` | text | n | **stored encrypted; never logged; masked in UI** | identity | HR (masked), self | HR |
| `created_at` / `updated_at` | timestamptz | y | — | internal | HR | system |

**Retention:** person survives while any employment is within its retention window; then minimised per `COMP-32`.

### `employment` — a period of employment

| Field | Type | Req | Notes | Class |
|---|---|---|---|---|
| `id` | uuid | y | | internal |
| `tenant_id` | uuid | y | **RLS key** | internal |
| `person_id` | uuid | y | | internal |
| `employee_number` | text | y | unique per tenant; **never reused** | internal |
| `work_email` | citext | n | unique per tenant | identity |
| `hire_date` | date | y | business date | employment |
| `exit_date` | date | n | ≥ hire_date | employment |
| `status` | enum | y | see state machine | employment |

**Only one employment per `(tenant_id, person_id)` may have status in (`pre_hire`,`active`,`on_leave`,`notice`).** Enforced by a partial unique index, not by application code.

### `employment_version` — effective-dated attributes

| Field | Type | Req | Notes |
|---|---|---|---|
| `id`, `tenant_id`, `employment_id` | uuid | y | |
| `valid_from` | date | y | |
| `valid_to` | date | n | NULL = current; must be ≥ `valid_from` |
| `recorded_at` | timestamptz | y | system-set |
| `org_unit_id` | uuid | y | |
| `position_id` | uuid | n | |
| `job_title` | text ≤150 | y | |
| `manager_employment_id` | uuid | n | NULL only for the top of the tree |
| `secondary_manager_employment_id` | uuid | n | dotted line |
| `employment_type` | enum | y | full_time, part_time, fixed_term, intern, contractor |
| `work_location` | text | n | |
| `cost_centre` | text | n | |
| `decided_by` | uuid | y | **NOT NULL** — the human accountable |
| `reason` | text ≤500 | y | **NOT NULL, non-empty after trim** |

**`reason NOT NULL` is a requirement, not a nicety** (`docs/07-fairness-and-transparency.md` Part 2). A change to a person that nobody had to justify in words is exactly the change nobody can explain a year later.

### `org_unit` — effective-dated tree

`id` · `tenant_id` · `parent_id` (NULL = root) · `name` · `code` (unique per tenant) · `valid_from` · `valid_to` · `recorded_at` · `decided_by` · `reason`.

Reorganisations are historical facts. "How many were in Payments on 1 July?" must be answerable after Payments is merged into Commerce.

### `position` — a seat

`id` · `tenant_id` · `code` · `title` · `org_unit_id` · `headcount` (default 1) · `salary_band_id` (nullable, band only — never an individual amount) · `status` (open / filled / closed) · `valid_from` · `valid_to`.

A position may be vacant. **Vacancy = a position whose headcount exceeds the count of employment_versions pointing at it on the as-of date.** Derived, never stored — a stored vacancy count drifts within a week.

### Platform tables (established here, used by every later module)

- **`audit_log`** — append-only. `tenant_id`, `actor_id`, `action`, `resource_type`, `resource_id`, `at`, `ip`, `before`/`after` (PII-redacted), `sensitive_read` boolean. Covers **reads** of `national_id_ref`, salary-band and DOB (`COMP-53`). UPDATE and DELETE revoked at the database role level, not prevented in application code.
- **`transparency_ledger`** — `subject_employment_id`, `what`, `decided_by`, `decided_at`, `reason`, `effective_from`, `ai_involved` (bool), `ai_basis` (text, nullable). Visible to the subject by default.
- **`data_classification`** — `table_name`, `column_name`, `classification`, `purpose`, `lawful_basis`, `retention_days`, `statutory_ref`. **Populated by a migration alongside every schema change**, and CI fails if a new column in a personal-data table has no row here (`COMP-34`).
- **`analytics_event`** — first-party event store (`docs/06-technology-decisions.md` §The analytics decision).

---

## Part 3 — Requirements

### REQ-001 — Tenant isolation is structural

```
GIVEN tenant A and tenant B both exist with employees
 WHEN any query runs in tenant A's session context
 THEN no row belonging to tenant B is returned, from any table, ever

GIVEN a request authenticated for tenant A
 WHEN it supplies a resource id belonging to tenant B
 THEN the response is 404 with an empty body — not 403, which confirms existence

GIVEN the application connects as the table owner role
 THEN RLS still applies, because every tenant-scoped table uses
      FORCE ROW LEVEL SECURITY
```

NFRs: `SEC-01`, `SEC-02`. **This is the single highest-consequence requirement in the module.** The test that proves it must never be deleted or skipped.

### REQ-002 — Create an employee

```
GIVEN Meera is an HR admin in tenant A
 WHEN she creates an employee with legal name, hire date, org unit, job title and reason
 THEN a person, an employment, and one employment_version [hire_date, NULL) are created
      atomically
  AND employee_number is generated, unique per tenant, and never reused
  AND decided_by = Meera, reason is stored, and an audit entry is written
  AND a transparency_ledger entry is created
  AND an employee.created analytics event is emitted (OBS-03)

GIVEN hire_date is 40 days in the future
 THEN the employment is created with status pre_hire and does NOT appear in
      current headcount

GIVEN legal_name is "   "
 THEN 422 with a field-level error; nothing is created
```

### REQ-003 — Change an effective-dated attribute

```
GIVEN Aisha's current version is [2023-04-01, NULL) in Engineering
 WHEN Rohan changes org unit to Payments effective 2026-09-01 with a reason
 THEN the current version is closed with valid_to = 2026-09-01
  AND a new version [2026-09-01, NULL) is appended
  AND no row is updated in place other than the closing valid_to
  AND Aisha is notified within 60s with what, when, who and why
  AND a transparency_ledger entry is created

GIVEN reason is empty or whitespace
 THEN 422 "A reason is required" — the change is refused

GIVEN Rohan is not Aisha's manager and not HR
 THEN 403, no state change (SEC-01)

GIVEN the effective date is before Aisha's hire_date
 THEN 422 "Effective date cannot be before the hire date (12 Apr 2023)"

GIVEN Rohan submits the identical change twice (double-tap)
 THEN exactly one new version exists (REL-03, idempotency key)
```

### REQ-004 — Point-in-time queries

```
GIVEN the transfer above
 WHEN headcount for Engineering is requested as of 2026-08-31
 THEN Aisha is counted in Engineering, exactly once

 WHEN requested as of 2026-09-01
 THEN Aisha is counted in Payments, exactly once, and not in Engineering

GIVEN a retroactive correction created a zero-length interval
 THEN a point-in-time query returns exactly one row for that person —
      never two, never zero
```

`PERF-03`: org chart / directory first render < 1.5s at 50,000 employees. `PERF-05`: point-in-time headcount < 3s at 3 years of history.

### REQ-005 — Aisha sees her own record and its history

```
GIVEN Aisha is authenticated
 WHEN she opens her record
 THEN she sees current values, and a chronological history of every
      effective-dated change with what, when, who decided, and why
  AND she sees who has viewed her sensitive data in the last 12 months
  AND the page is interactive in < 2s on a mid-range Android over 4G (PERF-01)
  AND it is completable by keyboard alone (A11Y-02)
```

NFRs: `COMP-20`, and `docs/07-fairness-and-transparency.md` Part 2.

### REQ-006 — Aisha corrects her own factual data

```
GIVEN Aisha changes her preferred name to "Aisha" from "Aisha Kumar"
 THEN it is saved immediately, with an audit entry showing before and after
  AND it propagates to the directory and org chart within 60s
  AND no HR approval is required

GIVEN Aisha attempts to change her job title or manager via the API directly
 THEN 403 — self-correctable fields are an allowlist enforced server-side,
      never a UI-only restriction
```

Self-correctable allowlist: `preferred_name`, `pronouns`, `personal_email`, `personal_phone`, `emergency_contact`, `profile_photo`. Nothing else, ever.

### REQ-007 — Directory with field-level visibility

Per `docs/07-fairness-and-transparency.md` default visibility matrix. Salary **bands** visible; individual salary not present in this module at all. Directory export is throttled and alerted (`SEC-10`, `COMP-60`).

### REQ-008 — Bulk import

```
GIVEN a 20,000-row CSV with 3 invalid rows
 THEN valid rows import, invalid rows are reported per row with the column
      and the reason, and the app is not locked during the import (PERF-07)
  AND the import is idempotent by external key — re-running does not duplicate
  AND a dry-run mode reports what would happen without writing
```

### REQ-009 — Data export (COMP-21)

Aisha exports her own data as JSON: person, employment, **every** employment_version with reasons, transparency ledger entries, and the access log of who viewed her sensitive data. Derived values included, not just the profile form.

### REQ-010 — Erasure propagation harness (COMP-22)

Even though Core HR writes to few stores, the erasure orchestrator and its test exist now, because **every later module plugs into it**. The test creates a person, spreads data across every store the module writes to, erases, and asserts each store independently.

---

## Part 4 — Employment state machine

| From | Event | To | Who | Side effects |
|---|---|---|---|---|
| — | create (future hire_date) | `pre_hire` | HR | ledger, audit; **excluded from headcount** |
| `pre_hire` | hire_date reached | `active` | system (job) | included in headcount; provisioning event |
| `pre_hire` | cancel | `cancelled` | HR | reason required |
| `active` | start long leave | `on_leave` | HR | still headcount, flagged |
| `on_leave` | return | `active` | HR | |
| `active` | resign / terminate | `notice` | HR | exit_date set; reason required |
| `notice` | exit_date reached | `exited` | system (job) | removed from headcount; **access revocation event (SEC-09)**; retention clock starts (`COMP-30`) |
| `exited` | rehire | new `employment` | HR | same person, new employment (Q-02) |

**`exited` is terminal.** Correcting a wrongly-exited employee appends a correcting version and re-opens; it does not silently mutate the exit.

---

## Part 5 — Permissions matrix

| Action | Employee | Manager (own team) | Skip-level | HR admin | IT admin |
|---|---|---|---|---|---|
| View own record + full history | ✅ | ✅ | ✅ | ✅ | ❌ |
| View colleague directory entry | ✅ visible fields | ✅ | ✅ | ✅ | ✅ |
| View team member full record | ❌ | ✅ | ✅ | ✅ | ❌ |
| View DOB / national ID | own only | ❌ | ❌ | ✅ masked | ❌ |
| Correct own factual fields | ✅ | ✅ | ✅ | ✅ | ❌ |
| Change org unit / title / manager | ❌ | ✅ own team | ✅ | ✅ | ❌ |
| Create / exit employee | ❌ | ❌ | ❌ | ✅ | ❌ |
| Bulk import | ❌ | ❌ | ❌ | ✅ | ❌ |
| Export directory | ❌ | ❌ | ❌ | ✅ throttled | ❌ |
| View who accessed a record | own only | ❌ | ❌ | ✅ | ❌ |

**The awkward cases, specified because they are where real systems break:**

- **HR admin acting on their own record** — permitted for factual fields; **forbidden for their own job, pay band, or manager.** Self-approval is a control failure. Enforced server-side.
- **A manager who reports to the person they are changing** — permitted, but flagged in the ledger as a reciprocal change and visible to HR.
- **Dotted-line manager** — read access to the team member's record; **no write access.** Secondary managers cannot change reporting lines.
- **A manager on leave** — their permissions persist; delegation is out of scope for v1 and HR is the fallback. Recorded as a known gap.

---

## Part 6 — Edge cases

**People** — mid-cycle joiner and leaver · rehire (same person, new employment) · transfer between org units · promotion (title + position change same date) · **dual reporting** · vacant manager position → reports roll up to the grandparent, and the UI says so rather than showing a blank · **employee who is their own manager** (founder — `manager_employment_id` NULL, allowed for exactly one active employment per tenant, enforced) · person with no work email (warehouse staff — employee_number is the identifier, and login must work without email) · single-name person · 200-character name · name in a non-Latin script.

**Time** — hire and exit on the same date (a one-day employment is valid) · exit before hire (rejected, 422) · change effective today vs tomorrow · **retroactive change crossing a month boundary** · two changes same effective date (later `recorded_at` wins) · a change effective on 29 Feb.

**Scale** — 3-person tenant · 50,000-employee tenant · manager with 200 direct reports (org chart must virtualise, not render 200 cards) · org tree 12 levels deep · **a cycle introduced in the reporting line** — rejected at write time with the cycle path named, because a cycle makes every recursive query hang.

**Failure** — decided_by user deleted after deciding (ledger retains the name as recorded — the ledger is a historical record, not a join) · notification service down (change still succeeds, notification queued — `REL-04`) · partial bulk-import failure · concurrent edits to the same employment (optimistic concurrency on `recorded_at`; second writer gets 409 with what changed).

**Trust** — can a manager see a skip-level's personal phone? **No.** · can HR see who viewed a record? **Yes.** · can an employee see who viewed *their* record? **Yes — this is a feature.** · does the directory leak DOB via a birthday feature? **There is no birthday feature in v1**, precisely because it leaks DOB by design and needs consent to be built properly.

---

## Part 7 — Microcopy

| Where | Text |
|---|---|
| Change reason field | `Why is this changing?` — placeholder: `Moving to Payments to lead the settlements work` |
| Empty reason error | `Please add a reason. Aisha will see this, so write it for her.` |
| Change notification | `Rohan changed your team from Engineering to Payments, effective 1 September. Reason: "…". Questions? Message Rohan.` |
| Own history heading | `Everything that's changed, and why` |
| Access log heading | `Who's looked at your details` |
| Empty access log | `No one has viewed your sensitive details in the last 12 months.` |
| Vacant manager | `This team's manager position is open. For now, {grandparent} covers it.` |
| Self-correct saved | `Saved. Your team will see this within a minute.` |
| Cycle rejected | `That would make {A} report to {B} and {B} report to {A}. Pick a different manager.` |
| Future-dated badge | `Takes effect 1 Sept` |

Every string is a key (`I18N-01`). No HR jargon (`UX-06`) — "Time in this role", not "Position Tenure Accrual".

## Part 8 — Events emitted

`employee.created` · `employee.attribute_changed` (with attribute name, not value) · `employee.status_changed` · `employee.self_corrected` · `org_unit.created` · `org_unit.changed` · `position.created` · `position.filled` · `position.vacated` · `record.viewed_own` · `record.sensitive_read` · `directory.exported` · `import.completed`.

All to the first-party `analytics_event` table. **No third-party analytics SDK in the employee-facing app** (`docs/06-technology-decisions.md`).

## Part 9 — NFRs and compliance in scope

`SEC-01` `SEC-02` `SEC-03` `SEC-05` `SEC-09` `SEC-10` · `PRIV-01` `PRIV-07` `PRIV-09` `PRIV-10` · `PERF-01` `PERF-03` `PERF-05` `PERF-07` · `SCALE-02` · `REL-03` `REL-04` `REL-07` `REL-08` `REL-09` · `OBS-01` `OBS-03` · `A11Y-01`–`A11Y-05` · `I18N-01` `I18N-02` `I18N-03` · `UX-02` `UX-04` `UX-05` `UX-06` · `COMP-01` `COMP-15` `COMP-20` `COMP-21` `COMP-22` `COMP-25` `COMP-30` `COMP-31` `COMP-32` `COMP-34` `COMP-53`.

**Not in scope, recorded deliberately:** `COMP-70`–`COMP-79` — **there is no AI in this module.** `AI-*` — same. Consent ledger UI — Core HR processing rests on the employment legitimate-use basis (`COMP-15`), not consent `[LAW — VERIFY per market]`.

## Open questions

- **Q-04 → PM:** should a future-dated change be visible to the employee immediately, or on the effective date? **Assumed immediately** — surprise is the enemy of trust. Not blocking.
- **Q-05 → PM:** should managers see *who else* viewed their team members' records? **Assumed no** — that is surveillance of HR by managers. Not blocking.
- **Q-06 → Full-Stack:** optimistic concurrency on `recorded_at` or a separate version counter? Not blocking; your call.
- **Q-07 → legal:** does any statutory filing require the historical legal name at the time of the transaction? **Blocking payroll, not blocking Core HR.**

## Handoff

**To:** hrms-fullstack-engineer, then hrms-test-automation
**Ready:** yes
**Blocking:** none. Q-07 must be resolved before payroll, not before this module.
**Assumptions to challenge:** legal name corrected in place rather than dated · self-correctable allowlist is the right set · no delegation for managers on leave in v1 · `exited` is terminal.

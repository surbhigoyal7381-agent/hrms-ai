# Thrive HRMS — Project Context

> Rename `Thrive` to your product name everywhere before you start.
> Every agent reads this file first. If something here is wrong, the whole team is wrong.
> Keep it under ~400 lines. When it grows past that, move detail into `docs/` and link.

---

## 1. Why this product exists

**Mission:** Help organisations get exponential results by making the workplace *thriving*.

We define a thriving workplace as four measurable things:

| Pillar | What it means in practice | How we will know |
|---|---|---|
| **Engagement** | People feel their work matters and they want to stay | eNPS, pulse participation %, 12-month regretted attrition |
| **Collaboration** | Work crosses team boundaries easily | % of goals with cross-team contributors, recognition sent across teams |
| **Inclusiveness** | Everyone gets a fair shot and a voice | Distribution of ratings / pay / promotions by group, % of employees who spoke in a listening cycle |
| **Transparency** | People can see the things that affect them | % of policies acknowledged, % of pay/leave/perf decisions with a visible reason, org data made deliberately open |

**We are not building "another HRMS with more modules."** Every module we build must move at least one pillar. If a feature cannot name its pillar and its metric, it does not get built.

## 2. Product truths (the tie-breakers)

Use these to settle arguments without escalating.

1. **The employee is the primary user, not HR.** HR admins are a supported persona, but the product is judged by whether an ordinary employee opens it voluntarily.
2. **Simple beats complete.** A feature 80% of people use beats a feature 100% configurable and 5% used.
3. **Transparency by default, privacy by design.** Default to showing people things about themselves and their team. Never leak what should be private. When these clash, privacy wins and we say so out loud in the UI.
4. **Money and time must be exactly right.** Payroll, leave balances, and attendance are correctness-critical. Everything else can be iterated; these cannot be "roughly right."
5. **AI assists, humans decide.** No AI system makes an adverse decision about a person (rating, pay cut, PIP, termination, rejection) on its own. Ever.
6. **Boring technology.** Complexity must buy something specific and named. See §7.
7. **Ship a thin slice end to end.** One real user doing one real job all the way through beats five half-built modules.

## 3. Who we serve (personas)

Use these names in every document. Write requirements as *"Aisha can..."*, not *"the user can..."*.

| Persona | Role | What they actually want | What they hate |
|---|---|---|---|
| **Aisha** | Employee, 3 yrs tenure, mobile-first | Apply leave in 10 seconds, know where she stands, feel seen | Logging in to check a balance; policy PDFs |
| **Rohan** | Team manager, 8 reports | Approve fast, spot a struggling person early, run a good 1:1 | Chasing forms; surprise attrition |
| **Meera** | HR Business Partner | Evidence for people decisions, run engagement cycles | Exporting to Excel to answer any question |
| **Sunil** | HR Ops / Payroll | Run payroll with zero errors, pass audit | Manual reconciliation; unexplained variances |
| **Priya** | CHRO / Founder | See workforce health and cost in one view | Dashboards no one trusts |
| **Dev** | IT Admin | Provision, integrate, prove it is secure | Bespoke permission models |

## 4. Domain map (what an HRMS contains)

Agents must know this map even when working on one corner of it.

- **Core HR** — employee master, org structure, positions, cost centres, documents, lifecycle events (hire → change → exit)
- **Onboarding / Offboarding** — pre-boarding, tasks, asset & access provisioning, exit clearance, F&F
- **Time** — attendance, shifts & rosters, leave/absence, holidays, timesheets, overtime
- **Payroll & Benefits** — salary structures, earnings/deductions, statutory components, payslips, reimbursements, benefits enrolment
- **Talent** — recruitment (ATS), performance & goals/OKRs, 1:1s, continuous feedback, calibration, succession
- **Learning & Skills** — skills taxonomy, courses, certifications, career paths
- **Engagement** — pulse surveys, eNPS, recognition, listening, action planning
- **Collaboration** — directory, org chart, team spaces, announcements, communities
- **People Analytics** — headcount, cost, attrition, DEI, manager effectiveness
- **Compliance & Cases** — policy acknowledgement, grievance / POSH, investigations, audit
- **Platform** — RBAC/ABAC, workflow engine, notifications, integrations, audit log, multi-tenancy, data residency

## 5. Where we intend to win

Most HRMS products are systems of record with an engagement module bolted on. Our bet is the opposite: an engagement and transparency system that happens to keep perfect records.

Working differentiators (**treat these as hypotheses to validate, not settled truth**):

1. **Transparency Ledger** — for every decision that affects a person (rating, pay change, leave rejection, shift change), the reason and the decider are recorded and visible to that person by default.
2. **Recognition that shows the real network** — recognition data builds a collaboration graph that surfaces the invisible connectors in an org.
3. **Manager nudges, not manager dashboards** — the system tells Rohan the one thing to do today, in his flow of work, instead of a dashboard he never opens.
4. **Fairness checks built into the workflow** — before a calibration or pay cycle is finalised, distribution is checked across groups and outliers are shown to the decider.
5. **Ten-second employee actions** — leave, attendance, payslip, recognition each complete in under 10 seconds on mobile.

**Competitive landscape to stay aware of** (verify current positioning before quoting any of it): Workday, SAP SuccessFactors, Oracle HCM (enterprise suites); Rippling, HiBob, BambooHR, Deel (mid-market/global); Darwinbox, Keka, Zoho People, greytHR (India); Lattice, Culture Amp, 15Five (engagement/performance); ERPNext / Frappe HR (open source — useful as a free reference for HR data models and workflow patterns, not our stack).

## 6. Non-functional requirements and compliance

- **NFRs:** `docs/03-nfr-catalog.md` — `SEC-*`, `PRIV-*`, `PERF-*`, `SCALE-*`, `REL-*`, `OBS-*`, `A11Y-*`, `I18N-*`, `AI-*`, `COST-*`, `UX-*`
- **Compliance:** `docs/05-compliance-catalog.md` — `COMP-*`, covering India's DPDP Act 2023 + DPDP Rules 2025, GDPR/UK GDPR, the EU AI Act's high-risk employment category, US state AI-hiring laws, CCPA/CPRA, and the standards enterprise buyers ask for (ISO/IEC 27001:2022, ISO/IEC 27701:2025, ISO/IEC 42001:2023, SOC 2, NIST CSF 2.0 / AI RMF).

Every requirement, design note, test plan and review cites these by ID.

### The compliance stance

**HR data is among the most sensitive personal data an organisation holds**, and HR is one of the very few domains where AI is named *high-risk* in law. That shapes the product, not just the paperwork:

1. **Compliance features are product features.** A retention policy with no purge job is a lie. An anonymity promise with an admin backdoor is a breach waiting to be reported. If the catalogue says the capability must exist, it is a requirement with an ID and a test, not a note for legal.
2. **Design the capability, not the jurisdiction.** Build "configurable retention per data category with the statutory reference recorded", never "delete after 8 years because India says so." Rules change — the EU deferred its high-risk AI obligations by 16 months while this file was being written. Capabilities survive; hard-coded rules do not.
3. **No agent states a legal requirement as settled fact.** Write it as `[LAW — VERIFY: <source>, as of <date>]`. These agents are not lawyers.
4. **Anything reaching a payslip, a rejection, a termination, or a regulator gets human legal sign-off before release.**
5. **Build for the strictest applicable rule**, then relax per tenant by configuration. Retrofitting strictness costs more than starting there.

## 7. Technology

> **STATUS: PROPOSED, NOT DECIDED.** This section is a starting point written by an assistant, not a validated architecture. The Full-Stack agent must confirm each line against current documentation before any of it is used, and the PM must approve the one-way doors. Replace this notice once the team has signed off.

**Proposed default stack** — chosen for boring, well-documented, widely-hired-for technology:

- Language: TypeScript end to end
- Frontend: React + Next.js (App Router), Tailwind CSS, a headless component library
- API: REST + OpenAPI as the contract; typed client generated from it
- Backend: Node (Next route handlers for BFF; a separate service only when a real boundary appears)
- Database: PostgreSQL, with a migration tool checked into the repo
- Cache/queue: Redis; a durable job runner for long-running work (payroll runs, imports)
- Files: S3-compatible object storage, signed URLs only
- Auth: OIDC/SAML SSO + SCIM provisioning; sessions server-side
- Observability: structured JSON logs (PII-redacted), traces, metrics
- CI: lint → typecheck → unit → integration → e2e → security scan, on every PR

**One-way doors — do not decide these without the PM and Full-Stack agent both signing off in `docs/99-decision-log.md`:**

1. **Multi-tenancy model** (shared schema with tenant_id / schema-per-tenant / database-per-tenant) — this decides your isolation story, your compliance story, and your migration pain forever.
2. **Time and timezone model** — store UTC, resolve to the employee's assigned work calendar; attendance and payroll periods are business dates, not timestamps.
3. **Money representation** — integer minor units + explicit currency. Never floats. Never.
4. **Effective-dated history** — every employee attribute that affects pay or reporting must be effective-dated from day one. Retrofitting this is a rewrite.
5. **Data residency** — whether a tenant's data can be pinned to a region, and enforced rather than merely documented (`COMP-40`, `COMP-43`).
6. **Data classification metadata on every personal-data field** — this is what generates your record of processing, your retention clocks, and your field-level permissions. Added later, it is an archaeology project across every table you ever wrote (`COMP-01`, `COMP-34`).

## 8. House rules for every agent

- **Plain language.** Write for Aisha and Sunil, not for an architecture review board. Short sentences. No jargon without a one-line definition on first use.
- **Show an example.** Every rule, requirement, and finding gets a concrete example with real-looking data.
- **Say what you do not know.** Flag assumptions as assumptions. Never state a guess as a fact. Never invent a library, an API method, a statistic, a competitor's feature, or a legal requirement — verify it or mark it unverified. Legal claims use `[LAW — VERIFY: source, as of date]`.
- **No over-engineering.** Apply the test in `docs/02-definition-of-done.md` §Simplicity. If you cannot name what the complexity buys, remove it.
- **Stay in your lane.** Each agent owns specific artefacts. Do not write another agent's artefact; raise a question in the decision log instead.
- **Handoffs are files, not conversations.** See `docs/01-handoff-protocol.md`.

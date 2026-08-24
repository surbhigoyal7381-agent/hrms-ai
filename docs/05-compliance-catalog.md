# Compliance Catalogue — data protection, security standards, and AI-in-HR law

**Read this before designing any module.** In HR software, compliance is not a legal review at the end — it is a set of features that must exist in the product. A retention policy with no purge job is a lie. An anonymity promise with an admin backdoor is a breach waiting to be reported.

---

## ⚠️ How to use this file — read this part twice

**I am not a lawyer, and neither are these agents.** Everything below was checked against public sources in **August 2026** and is provided to tell you *what to ask your counsel about*, not to tell you what the law is. Laws, rules, effective dates and enforcement postures change — the EU deferred its high-risk AI obligations by 16 months while this file was being written.

Three rules for every agent:

1. **Never state a legal requirement as settled fact.** Write it as `[LAW — VERIFY: <source>, as of <date>]`.
2. **Design the capability, not the jurisdiction.** Build "configurable retention period per data category" rather than "delete after 8 years because India says so." Rules change; capabilities survive.
3. **Anything that reaches a payslip, a rejection letter, a termination, or a regulator gets human legal sign-off before release.** No exceptions, no "the agent said it was fine."

**Before you build in a market, confirm the current position with qualified counsel in that market.**

---

## 1. Frameworks in scope

| Framework | Applies when | Status as checked (Aug 2026) — **verify** |
|---|---|---|
| **India — DPDP Act 2023 + DPDP Rules 2025** | Processing personal data of people in India | Rules finalised Nov 2025. Reported phasing: Data Protection Board established Nov 2025; Consent Manager framework operational ~13 Nov 2026; **full compliance ~13 May 2027**. Verify against the official notification. |
| **India — IT Act s.43A / SPDI Rules 2011** | Sensitive personal data; predates DPDP | Interaction with DPDP is a legal question — ask counsel |
| **India — CERT-In Directions (2022)** | Cyber incident reporting, log retention | Reported to require incident reporting on a very short clock (widely cited as 6 hours) and 180-day log retention in India `[VERIFY — this is frequently mis-stated]` |
| **India — labour & tax statutes** | Payroll registers, wage records, PF/ESI/TDS filings | Retention periods are statute-specific; get the list from counsel and encode as parameters |
| **EU/UK — GDPR / UK GDPR** | EU/UK data subjects, incl. your own employees | Art. 6 lawful basis, Art. 9 special categories, Art. 15 access, Art. 17 erasure, Art. 22 automated decisions, Art. 30 RoPA, Art. 33 breach notice within 72h, Art. 35 DPIA, Ch. V transfers |
| **EU — AI Act** | AI used in recruitment, selection, performance evaluation, task allocation, worker monitoring, promotion or termination decisions (Annex III **high-risk**) | High-risk obligations originally 2 Aug 2026; the **Digital AI Omnibus** deferred them to **2 Dec 2027** (reported in force 27 Jul 2026). `[VERIFY — this moved recently and may move again]` |
| **US — NYC Local Law 144** | Automated Employment Decision Tools used for NYC roles | In effect since Jul 2023. Annual independent bias audit, **published results**, candidate notice ≥10 business days before use |
| **US — Illinois AI Video Interview Act** | AI analysis of interview video | In effect since 1 Jan 2020. Notice + written consent, restricted sharing, deletion on request within 30 days |
| **US — Illinois HB 3773** | AI in employment decisions | Reported effective 2026 `[VERIFY exact date and scope]` |
| **US — Colorado SB 24-205** | AI in consequential employment decisions | Reported effective 30 Jun 2026 after amendment/delay. Impact assessments, risk-management programme, pre-adverse-decision notice, human review right `[VERIFY — this one has been amended more than once]` |
| **US — Maryland HB 1202** | Facial recognition in hiring | Written consent required |
| **US — CCPA/CPRA** | California residents, **including employees** | Employee data is in scope |
| **US — HIPAA** | Only if you handle protected health information | Usually avoidable in an HRMS — prefer not to touch PHI |
| **PCI DSS 4.x** | Only if you touch card data | Usually avoidable — use a payment provider and stay out of scope |
| **ISO/IEC 27001:2022** | Enterprise buyers will ask | ISMS certification |
| **ISO/IEC 27701:2025** | Privacy management | Republished **14 Oct 2025** as a **standalone certifiable PIMS**, no longer only an ISO 27001 extension. Transition window for 2019 certificates — confirm dates with your certification body |
| **ISO/IEC 42001:2023** | AI management system | Increasingly requested when you sell AI features into enterprises |
| **SOC 2 Type II** | US enterprise buyers | Trust Services Criteria; expect it to be a deal gate |
| **NIST CSF 2.0 / NIST AI RMF 1.0** | Voluntary but useful scaffolding | Good internal structure even where not required |

---

## 2. COMP — Compliance requirement IDs

Cite these the way you cite `SEC-*` and `PRIV-*`. They belong in requirements, design notes, test plans and reviews.

### Governance and records

| ID | Requirement |
|---|---|
| COMP-01 | **RoPA** — a machine-maintained record of processing activities: what data, why, lawful basis, who it is shared with, where it is stored, how long it is kept. Generated from the data-classification metadata, not maintained in a spreadsheet. |
| COMP-02 | **DPIA register** — a documented impact assessment for high-risk processing (biometrics, monitoring, AI in people decisions, large-scale profiling), with review dates. |
| COMP-03 | **AI system inventory** — every AI/LLM feature registered with its purpose, risk classification, training/prompting basis, human-oversight design, and last evaluation date. |
| COMP-04 | **Sub-processor register** — every third party that touches personal data, with the contract, the DPA, and the transfer mechanism. Model API providers count. |
| COMP-05 | **Policy acknowledgement with evidence** — who accepted which policy version, when, and the ability to re-request on version change. |
| COMP-06 | **Grievance / DPO contact is published in-product**, with a tracked response clock. |

### Consent and lawful basis

| ID | Requirement |
|---|---|
| COMP-10 | Every data collection point is bound to a **purpose** and a **lawful basis** in configuration, not in code. |
| COMP-11 | **Notice is separate, itemised and plain-language** — not buried in terms of service. Versioned, with a record of what each person was shown. |
| COMP-12 | **Withdrawal is as easy as consent.** One control, same number of clicks, effective immediately, with a visible consequence ("your biometric punch will be disabled; use the PIN method"). |
| COMP-13 | **Consent ledger** — immutable record of grant, scope, version, timestamp, and withdrawal. |
| COMP-14 | **Consent Manager interoperability** (India, DPDP) — architected as a pluggable interface so an external consent manager can be integrated when required. |
| COMP-15 | **Employment legitimate-use path** — where processing does not rest on consent (payroll, statutory filing), the basis is recorded explicitly rather than a consent flag being faked. |
| COMP-16 | **Children's / minor's data** — if any is processed (dependants, beneficiaries, apprentices), verified guardian consent and no behavioural tracking. |

### Data subject / data principal rights

| ID | Requirement |
|---|---|
| COMP-20 | **Rights Centre** — a self-service screen where a person can see, export, correct, and request erasure of their own data, and withdraw consent. Not an email address. Not an HR ticket. |
| COMP-21 | **Export is machine-readable and complete** — includes derived data (ratings, scores, AI outputs, engagement history), not just the profile form. |
| COMP-22 | **Erasure propagates** — primary store, replicas, search index, cache, analytics warehouse, backups (documented approach), logs, and every third party. A delete that leaves the row in OpenSearch is not a delete. |
| COMP-23 | **Legal hold overrides erasure**, is auditable, and the person is told a hold exists where the law permits. |
| COMP-24 | **Response clocks are tracked** with escalation before breach — grievances, access requests, corrections. |
| COMP-25 | **Correction workflow** with an audit trail of the before value, the after value, who changed it and why. |

### Retention and minimisation

| ID | Requirement |
|---|---|
| COMP-30 | **Retention schedule is data, not code.** Per data category, per jurisdiction, per employment status, configurable, with the statutory reference recorded. |
| COMP-31 | **Automated purge actually runs**, is monitored, produces an auditable report, and is tested. |
| COMP-32 | **Ex-employee minimisation** — after the statutory window, reduce to the minimum lawful record (employment dates, statutory filings) and delete the rest. |
| COMP-33 | **Candidate data expiry** — rejected candidates purge on schedule unless they consented to a talent pool, with the consent renewable and revocable. |
| COMP-34 | **Field-level minimisation gate** — a new personal-data field cannot be added without a named feature, a classification, and a retention period. Enforce it in the requirements template. |

### Cross-border and residency

| ID | Requirement |
|---|---|
| COMP-40 | **Data residency is an architecture capability**, chosen deliberately (see one-way doors in `CLAUDE.md`). Retrofitting it is a rebuild. |
| COMP-41 | **Transfer mechanism recorded per destination** (adequacy, SCCs, or whatever applies), including to your model provider and your support tooling. |
| COMP-42 | **Support access from another region is a transfer.** Treat impersonation and support tooling as in-scope, time-boxed, consented and audited. |
| COMP-43 | **Restricted-transfer switch** — a tenant can be configured so its data never leaves a region, and the system enforces it rather than documenting it. |

### Security controls that auditors will ask for

| ID | Requirement |
|---|---|
| COMP-50 | **Access reviews** — periodic, evidenced, with an exportable report. Privileged access reviewed more often. |
| COMP-51 | **MFA and SSO enforced**; break-glass accounts are time-boxed and alarmed. |
| COMP-52 | **Key management** — documented, rotated, with encryption at rest for data and backups. Consider per-tenant keys if enterprises demand them. |
| COMP-53 | **Immutable audit log**, retained for the required period, exportable for an auditor, covering sensitive reads as well as writes. |
| COMP-54 | **Backup restore rehearsed**, with the result recorded. Untested backups are not a control. |
| COMP-55 | **Vulnerability management** — dependency scanning, patch SLAs by severity, penetration test cadence. |
| COMP-56 | **Change management evidence** — who approved, what was tested, how it was rolled back. Your CI already produces most of this; make it exportable. |
| COMP-57 | **Business continuity / disaster recovery plan** with an RTO and RPO that payroll can actually live with. |
| COMP-58 | **Secure SDLC evidence** — code review, SAST/DAST, secrets scanning, and the fact that an independent reviewer gated the release. Your five-agent pipeline generates this evidence naturally; make sure it is retained. |

### Breach response

| ID | Requirement |
|---|---|
| COMP-60 | **Detection** — alerting on mass export, anomalous access to salary or identity fields, privilege escalation, and cross-tenant access attempts. |
| COMP-61 | **Breach register** in-product, with a workflow that meets the shortest applicable clock. Note that clocks differ sharply by jurisdiction (GDPR reports 72 hours to the authority; India's CERT-In directions are widely cited as far shorter) `[VERIFY both]`. **Design for the shortest.** |
| COMP-62 | **Affected-person notification templates** and the ability to determine exactly whose data was in scope — which requires the audit log to be good enough to answer that question. |
| COMP-63 | **Post-incident review** recorded, with the corrective action tracked to closure. |

### AI in HR — the high-risk category

This section exists because HR is one of the few domains where AI is explicitly named high-risk in law.

| ID | Requirement |
|---|---|
| COMP-70 | **Classify every AI feature.** Recruitment, candidate selection, performance evaluation, task allocation, worker monitoring, promotion and termination decisions fall in the EU AI Act's high-risk Annex III category. Suggestion features that feed those decisions are in scope too — do not classify by intention, classify by effect. |
| COMP-71 | **Human oversight is designed, evidenced and meaningful.** A recorded human decider, with the information and the time to disagree. A rubber-stamp button is not oversight and will not be treated as such. |
| COMP-72 | **Notice to the affected person** that AI was involved, in plain language, before or at the point of the decision. |
| COMP-73 | **Explanation and contest** — the person can see the main factors and challenge the outcome through a route that reaches a human. |
| COMP-74 | **Bias audit** — periodic, independent where required (NYC requires an *independent* audit and **publication** of the results, with candidate notice ≥10 business days before use). Build the data export the auditor needs; you cannot audit what you did not log. |
| COMP-75 | **Impact assessment** for consequential AI decisions, refreshed on material change (Colorado-style requirements point this way). |
| COMP-76 | **Logging for the lifetime required** — AI inputs, outputs, model/prompt version, and the human decision, retained long enough to answer a regulator or a claim. |
| COMP-77 | **Video/biometric analysis in hiring** — notice, written consent, restricted sharing, deletion on request, and a non-AI alternative path. Several jurisdictions regulate this specifically. |
| COMP-78 | **Accuracy, robustness and cybersecurity claims** are evidenced by your eval suite (`AI-05`), not asserted in marketing. |
| COMP-79 | **A kill switch per AI feature, per tenant.** When a jurisdiction changes its mind — and it will — you turn the feature off for that tenant in minutes, not in a release cycle. |
| COMP-80 | **Biometric attendance** — treat as special-category data everywhere. Explicit consent, a genuinely usable non-biometric alternative, template storage rather than raw images, deletion on exit, and no secondary use. |

---

## 3. Module → compliance features that must be built

This is the part the product roadmap needs. Each module carries features that exist **only** because of compliance, and they are not optional extras — leave them out and the module cannot be sold into an enterprise or a regulated market.

| Module | Compliance features that ship with it |
|---|---|
| **Core HR / employee master** | Field-level classification metadata · per-field retention clock · correction workflow with audit · self-service data view/export · sensitive-read audit · consent/basis record per field group |
| **Recruitment / ATS** | Candidate privacy notice + consent capture · AEDT notice ≥10 business days where applicable · bias-audit data export · AI-involvement disclosure · human decider recorded on every rejection · candidate data auto-expiry with talent-pool opt-in · video-interview consent and deletion-on-request |
| **Onboarding** | Encrypted document vault with retention · ID document masking in UI · background-check consent record · access provisioning tied to role, revoked on exit |
| **Attendance / time** | Biometric consent with a real non-biometric alternative · template-not-image storage · biometric deletion on exit · monitoring transparency notice · location-tracking justification and opt-out where lawful |
| **Payroll & benefits** | Bank/tax identifier encryption or tokenisation · statutory register generation · payslip access restricted to the individual and authorised roles · retention aligned to tax statute · immutable calculation audit trail · DPA in place with every payroll vendor |
| **Performance & talent** | AI-suggestion disclosure · recorded human decider on every rating and promotion decision · explanation and contest route · calibration fairness record · AI decision logs retained · high-risk AI documentation pack |
| **Engagement & surveys** | Technically enforced anonymity · small-group suppression threshold `[n=5]` with no admin override path · separate storage from the identity graph · explicit consent for sensitive/DEI questions · no re-identification via cross-filter |
| **Learning** | Minimal data collection · no covert progress monitoring · completion data purpose-limited |
| **People analytics** | Aggregation and suppression thresholds enforced in the query layer · no individual-level DEI exposure · purpose limitation per dashboard · export audit |
| **Cases / POSH / grievance** | Strict need-to-know access · confidentiality enforced in the data model · legal hold · statutory retention · complainant protection from access-log exposure |
| **Directory & collaboration** | Per-field visibility controls · directory export throttled and alerted · opt-out for personal contact fields |
| **Platform** | **Rights Centre** · **Consent ledger** · **Compliance Command Centre** (RoPA, DPIA register, AI inventory, sub-processor register, breach register, retention dashboard, access-review reports) · residency enforcement · breach detection and notification workflow · immutable audit log · SSO/MFA · key management · time-boxed audited impersonation |

> **A product opportunity, not just a cost.** The Rights Centre and the Compliance Command Centre are the transparency pillar made real, and most incumbents bolt them on as admin screens nobody enjoys using. Building them as first-class, plainly-worded product surfaces is a defensible differentiator — flag it to the PM agent rather than treating it as overhead.

---

## 4. Practical sequencing

You cannot build all of this before your first release. Build in this order, and say out loud what is deferred:

1. **Now, or you will rewrite:** data classification metadata, tenant isolation, audit log, encryption, the residency decision, retention as configuration.
2. **Before your first paying enterprise customer:** Rights Centre, consent ledger, retention purge that runs, access reviews, breach workflow, sub-processor register.
3. **Before you ship any AI feature that touches a person's outcome:** COMP-70 to COMP-79 in full. Not after. Not in the next sprint.
4. **Before you sell into the EU or NYC:** the bias audit pipeline and the high-risk documentation pack.
5. **When a buyer asks:** SOC 2 / ISO 27001 / ISO 27701 certification. The controls should already exist by then; certification is evidence collection, not new engineering.

## 5. Sources checked (August 2026)

Every one of these is secondary commentary. **Confirm against the primary instrument and your own counsel before relying on any of it.**

- India DPDP Rules 2025 timeline and employer exception — [Fisher Phillips](https://www.fisherphillips.com/en/insights/insights/indias-new-data-privacy-rules-are-here), [PIB notification PDF](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)
- EU AI Act high-risk deferral to 2 Dec 2027 — [DLA Piper](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/The-Digital-AI-Omnibus-Proposed-deferral-of-high-risk-AI-obligations-under-the-AI-Act)
- US state AI hiring laws and effective dates — [AI Laws by State](https://www.ailawsbystate.com/blog/ai-hiring-laws-by-state-compliance-map)
- ISO/IEC 27701:2025 standalone status, published 14 Oct 2025 — [Coalfire](https://coalfire.com/the-coalfire-blog/iso-iec-277012025-privacy-takes-center-stage), [ISO catalogue entry](https://www.iso.org/standard/27701)

---
feature: 002-employee-self-service-record-view
artefact: decision-log
status: append-only
---

# Decision log — Employee self-service record view and history

Append only. Corrections append; they never overwrite.

### 2026-08-26 — The record view is a tenant setting, and it is off by default
**Decided by:** a human, before requirements were written.
**Decision:** whether an employee can open "My record" is one organisation-level setting. It is **off by default**. HR of that person keeps access either way.
**What this actually changes:** only whether the *employee* can see their own record. "HR keeps access" moves **no row** in the `docs/07-fairness-and-transparency.md` Part 2 matrix — HR already had a tick on every relevant row. Recorded as a restatement of the existing default, not a new grant.
**Charter position, stated plainly:** the restriction is permitted — Part 2 says "Tenant admins may restrict these further." The **default** is the part in tension with the Part 2 rule ("Default to showing a person everything that is about them") and with `CLAUDE.md` product truth 3 ("Transparency by default"). That tension is accepted knowingly, not overlooked.
**Cost:** in a default-configured tenant the ★ wow moment — Aisha reading her own access log — happens for nobody. The feature's reach is now whatever tenant activation turns out to be.

### 2026-08-26 — Q-06 resolved: right of access is carved out of the switch
**Question:** must `COMP-20` (right of access) and `COMP-21` (export) stay available when the setting is off?
**Decision:** **Yes. Carved out.** "Download my data", a minimal own-fields view, and the published DPO/grievance contact (`COMP-06`) are available regardless of the tenant setting. The switch governs the *experience* — the record view, the change history, the access log — never the statutory right.
**Why:** there is no other path to a person's own data anywhere in this product. No HR admin UI, no request workflow. Without the carve-out, a new tenant ships with `COMP-20` and `COMP-21` unserved by default. `COMP-20` itself says the Rights Centre is "Not an email address. Not an HR ticket." `CLAUDE.md` §6: build for the strictest applicable rule, then relax per tenant.
**The line that settles it:** a tenant may reasonably decide how much of its internal decision-making it narrates to employees; it should not be able to switch off a person's statutory right by leaving a default alone.
**`[LAW — VERIFY: DPDP Act 2023 / DPDP Rules 2025, and GDPR Arts. 15 and 20, as of 2026-08-25]`** — and note the counter-argument recorded in `10-opportunity.md`: right of access is the *employer's* obligation as controller, not ours as processor, so default-off would not by itself put a customer in breach. We are choosing the stricter position deliberately.

### 2026-08-26 — Q-05 resolved: off by default indefinitely, revisited on customer demand
**Question:** is this a permanent policy switch, or a staged-rollout flag with a dated default-flip?
**Decision:** **neither, exactly.** The setting stays, and stays **off by default, with no scheduled flip**. It is not temporary launch scaffolding and it carries no expiry date. The default changes only if a human decides it should, and the trigger for revisiting is **demonstrated customer demand for this specific feature**.
**What this means in practice:**
- Do **not** build a dated default-flip, a migration that turns tenants on, or anything that assumes every tenant ends up on.
- Do **not** describe it to customers as temporary or as "coming soon by default."
- Treat it as the current default with a named revisit condition, not as settled forever.
**What we must therefore measure:** demand has to be observable or the revisit trigger can never fire. Tenant activation, deactivations with reasons, and requests for the feature are the evidence. The metric in `10-opportunity.md` already reports activation as the leading indicator; that is now load-bearing rather than informational.
**Open:** what counts as "enough demand" is not defined, and deliberately so. **Owner: the human.**

### 2026-08-26 — Future-dated changes stay visible; no hiding switch
**Raised by:** the human — the worry that some employers will not want employees seeing scheduled changes in advance, to avoid disturbance.
**Decision:** **option A. Nothing is hidden.** If a change is in the record, the person it is about can see it, immediately. No second setting, no delay window, no per-change suppression. This reaffirms feature 001's Q-04 rather than reopening it.
**Why the employer's worry is real but is not solved by hiding:** what a manager usually wants is to deliver the news personally, which is decent management. The fix is *when the change gets written*, not *who can see it*. A reorg still being sketched is a plan, not a change to Aisha's job. Once it is committed to her record as effective-dated, the company has decided, and she sees it. So: keep planning in the planning stage; write to the record when it is real.
**Charter position:** `docs/07-fairness-and-transparency.md` Part 2 lists the legitimate limits — promised anonymity, small groups, ongoing investigations, other people's data, genuine security. A pending reorg is none of them. Part 2 also names what never counts, including "it might increase attrition". "To avoid disturbance" sits close enough to that line that hiding would have been a standing review finding.
**The case that decided it:** if future-dated changes were hideable, a company could record an employee's **exit date** while that person could not see it. That fails the Part 3 overriding test — would we be comfortable explaining it, in plain language, to the person it operates on.
**Rejected alternatives, recorded so they are not re-argued from scratch:**
- *A bounded "let the manager tell them first" delay* — days not indefinite, logged, visible after the fact, never for exit dates. Acceptable if a customer pushes hard. Not built now; no customer has asked.
- *Employer-controlled indefinite hiding* — would have required overruling this charter section and feature 001's Q-04 on the record. Not taken.
**Consequence for the build:** no new setting to design or test. The requirement is the existing one — future-dated changes are shown, labelled with when they take effect.

### 2026-08-26 — Q-09 from hrms-business-analyst to the human, the PM and counsel — BLOCKING
**The carve-out does not reach the people most likely to use it.** `10-opportunity.md` and the Q-06 decision say a default-off tenant still serves `COMP-20` and `COMP-21` because "Download my data" is always available. That holds only for someone who can sign in. Feature 001 revokes access at exit (`SEC-09`, the `notice → exited` transition emits an access-revocation event), so **an ex-employee has no route to their own data anywhere in this product** — no login, no HR admin UI, no request workflow.
**Not editing the brief.** Recorded here and specified as REQ-022 in `20-requirements.md`, with two named options: (a) a time-boxed post-exit access window reaching the carve-out screen only, or (b) an unauthenticated published DPO route with the `COMP-24` clock tracked.
**Recommendation:** build (a), and publish (b) regardless. **Blocking**, because it decides whether the carve-out delivers what the decision above says it delivers.
`[LAW — VERIFY: access-request response clock and whether an ex-employee's request may be served outside a self-service screen — DPDP Act 2023 / DPDP Rules 2025, GDPR Arts. 12(3) and 15. Unverified, as of 2026-08-26.]`

### 2026-08-26 — Q-12 from hrms-business-analyst to hrms-fullstack-engineer — BLOCKING
**A latent `COMP-22` defect in shipped code, found while checking whether the access log can name the person who looked.** `audit_log.actor_id` and `transparency_ledger.decided_by` are written from `Principal.actorId` (`employment.ts`). `erasure.ts` erases them by matching `actor_id IN (SELECT id FROM employment WHERE person_id = $1)` — an **employment id**. `Principal` carries `actorId` and `employmentId` as separate fields, which implies they are not the same value. If they differ, erasure already misses both stores and the 88 passing tests do not catch it.
**Assumed for now:** they are the same value. **Please confirm before the access log is built on top of it.** Related, and specified as REQ-020: `audit_log` has no denormalised actor name, so a viewer who leaves cannot be named the way `transparency_ledger.decided_by_name` names a departed decider.

### 2026-08-26 — Note from hrms-business-analyst to hrms-product-manager, non-blocking
**The purpose assumption is only half true.** The brief asked me to confirm that a purpose is derivable from the calling code path before it is promised in the UI. It is derivable from `audit_log.action`, because `action` is a closed set our own code writes — but a purpose derived from an action reads as a restatement of the action ("Looking at your details"), not as the business purpose in the wow-moment example ("annual pay review"). `20-requirements.md` RULE-004 therefore specifies an explicit `purpose_code` recorded at each read path, from a closed seven-value list, with the action-derived text as the fallback and "Reason not recorded" plus an alert as the last resort. **If the engineer says an explicit purpose code is impractical on some path, the wow moment degrades and you need to know early.** → Q-10.

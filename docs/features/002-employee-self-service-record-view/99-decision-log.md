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

### 2026-08-26 — Q-09 resolved: a post-exit window now, a tracked request route in 003
**Raised by:** hrms-business-analyst, BLOCKING — feature 001 revokes access at exit, so the Q-06 carve-out served everyone except ex-employees, the population most likely to exercise the right.
**Asked by the human:** time-boxed post-exit window, or an unauthenticated DPO route with a tracked clock — and what happens if the ex-employee misses the window.
**That second question decides it.** The right of access does not expire while the company still holds the data. `[LAW — VERIFY: GDPR Art. 15, and DPDP Act 2023 / DPDP Rules 2025, as of 2026-08-26]` There is also no retention purge job yet (feature 001, not implemented), so data is held indefinitely and the right persists indefinitely. A window alone would quietly tell people their right had expired. It cannot be the mechanism.

**Decision — two routes with different jobs:**
1. **The window is convenience.** Sign-in keeps working for a defined period after exit, so the existing self-serve export covers the common case. Cheap: the login and the export already exist. **In scope for feature 002.**
2. **The durable route is the obligation.** A tracked request that works for as long as the data is held, with identity verification and the `COMP-24` response clock. **Feature 003, not 002.**

**Why not "request HR":** `COMP-20` rules it out in as many words — "Not an email address. Not an HR ticket." Not for purity: an inbox produces no clock, no audit trail and no evidence. HR still *fulfils* the request — the employer is the controller and it is their obligation — but it must land somewhere that starts a clock and escalates before breach (`COMP-24`).

**The hard part, recorded so 003 does not underestimate it:** an unauthenticated route must prove who is asking without leaking. If the response differs depending on whether that person ever worked there, we have built a way to confirm anyone's employment history to any stranger — responses must be indistinguishable either way. And identity verification must not collect more sensitive data than we hold; demanding a passport to release a phone number is its own privacy problem.

**ACCEPTED DEBT, stated plainly rather than left as a footnote:** until feature 003 ships, the durable route *is* the published DPO contact — which is exactly the "email address" `COMP-20` says is not good enough. This is a known, deliberate gap.
**Owner:** hrms-product-manager to scope feature 003. **Review date: 2026-11-30.** If 003 has not shipped by then, this debt is re-raised at the next release gate rather than ageing quietly.

### 2026-08-26 — Q-12 ANSWERED by hrms-fullstack-engineer: it was a real defect, and it is fixed
**The BA's assumption was wrong.** `Principal.actorId` and `Principal.employmentId` were separate fields holding different values. `employment.ts` wrote `actorId` into `audit_log.actor_id`, `analytics_event.actor_id` and `transparency_ledger.decided_by`; `erasure.ts` matched those columns against `employment.id`. Reproduced on postgres:16 through the shipped code path: 1 audit row existed, the erasure predicate matched 0, and after `erasePerson` every store still named the actor. **Erasure was silently erasing nothing in three of six stores, and the test asserted with the eraser's own predicate so it compared zero to zero and passed.**
**Fixed** before feature 002's design note was written: `actor_id` and `decided_by` now mean `employment.id`, enforced by composite foreign keys `(tenant_id, column) REFERENCES employment (tenant_id, id)` in `packages/db/migrations/0002_actor_is_an_employment.sql`, and by a single non-null branded `actorEmploymentId` on `Principal`. Full entry in `docs/features/001-core-hr-foundation/99-decision-log.md`, same date.
**Consequence for this feature:** REQ-020's access log is now safe to build on `actor_id`. A second defect surfaced with it — every principal in the old suite shared one `actorId`, so a change Rohan made was recorded as decided by HR, under a test named *"the accountable human cannot be forged"*. REQ-003's "who decided" column is only truthful because of that fix. **Q-12 is closed.**

### 2026-08-26 — Q-13 ANSWERED: a correcting ledger entry points backwards, it never rewrites
**Decision:** add `supersedes_ledger_id uuid REFERENCES transparency_ledger(id)` to `transparency_ledger`. A correction inserts a **new** row carrying the pointer; the original is untouched, so `REVOKE UPDATE` stands and **no new column grant is needed** — which is what makes this better than the alternative. The read path renders rows no live successor points at. A unique partial index on `supersedes_ledger_id` stops a forked chain.
**Rejected:** a `superseded_for_display` boolean on the original row — it requires `GRANT UPDATE` on a column of an append-only table, and feature 001 deliberately kept that pattern to the two places it could justify.
**REQ-021 is unblocked.**

### 2026-08-26 — Q-19 to the human: tenant-specific sign-in addresses enumerate customers
**Raised by:** hrms-fullstack-engineer, while designing REQ-031.
The BA's assumption 12 — that the closed-window page is reached at a **tenant-specific** sign-in address — is load-bearing and correct: it is what makes rendering that tenant's DPO contact to every caller safe, and REQ-031 does not survive without it. **Its consequence is not in the requirements:** if `northwind.thrive.app` answers and `notacustomer.thrive.app` does not, the address space can be used to test whether a company is a customer. That is a much lower severity than confirming an individual's employment history, and it is a different disclosure — about the customer, not about a person.
**Recommendation:** accept it deliberately and record it, rather than inherit it. **If the answer is instead that sign-in must be one shared address, REQ-031 needs re-deriving** — the page could then not name any contact without answering "which employer". **Not blocking the build; blocking the sign-in surface's shape.**

### 2026-08-26 — Q-20 to hrms-business-analyst and counsel: the masked national ID is not buildable
**REQ-002 says national ID is shown masked, last 4 characters. RULE-012 says the column is application-layer encrypted with no decryption path. Both cannot be true** — the last 4 characters of ciphertext are four meaningless characters presented to Aisha as her identity number.
**What is actually in the code**, checked rather than assumed: nothing reads or writes `national_id_ref` except redaction and erasure, and **there is no encryption code anywhere in this product** — no `encrypt`, no `decrypt`, no key management, in any package. Migration 0001 line 79 asserts `SEC-04` in a comment that describes a control that was never built. The column is always `NULL` today.
**Recommendation: do not render national ID in this feature at all.** Say in RULE-012's `not_included` that the field exists and how to obtain it. Building the mask would mean inventing an encryption scheme — envelope encryption, key rotation, key management, and a stored non-secret "last 4" if masking is genuinely wanted — inside a feature about a read-only screen. `SEC-04` deserves its own design note.
**Blocks:** REQ-002's national-ID line and RULE-012's masking line, and nothing else. Q-11 is moot until this is settled.

### 2026-08-26 — Q-21 to hrms-business-analyst: REQ-014's "same transaction" cannot cover the export
REQ-014 requires the audit write in the same transaction as the response, so a failed audit write returns no data. **Correct for the record view, not implementable for the export**, which RULE-012 requires to be streamed and, above a threshold, asynchronous. Holding a transaction open across a multi-megabyte stream pins a connection for its duration, which is a denial-of-service against the same rate limits `SEC-10` sets.
**Proposed:** for the export, write and **commit** the audit entry before the first byte is streamed. REQ-014's guarantee is preserved and slightly strengthened — the entry exists even if the stream later fails — and the `export_artefact` row records the outcome so a failed export is distinguishable in the audit trail. **Not blocking; correct me if this weakens something I have not seen.**

### 2026-08-26 — Q-22 recorded: hash-based CSP, because REQ-031 asks for byte-identical responses
REQ-031 asks for responses byte-identical *"including any nonce or token position"*. A nonce-based Content Security Policy generates fresh randomness per response by design, so that assertion is unsatisfiable wherever one is used. **Resolved by using hash-based CSP on the closed-window page and the access log**, so there is no per-response randomness at all and the requirement is literally true rather than true-after-normalisation. Recorded because it constrains the CSP choice on those pages: **an engineer later switching them to nonces would silently break REQ-031.**

### 2026-08-26 — The `app.tenant_id` hole: three locks in feature 002, per-tenant roles as a separate project
**Raised by:** hrms-business-analyst in the feature 002 handoff, carried from feature 001's accepted debt. **Assessed by** hrms-fullstack-engineer against a real PostgreSQL 16 rather than from reasoning, because the answer was the opposite of what was expected.

**Verified findings:**
1. The application role can set `app.tenant_id` freely. **`REVOKE SET ON PARAMETER` does not constrain a custom placeholder variable** — the `REVOKE` reports success and creates no row in `pg_parameter_acl`. Anyone "fixing" this with a `REVOKE` and not checking the catalogue will believe they have closed it. `ALTER DATABASE … SET` first does not help either.
2. `REVOKE EXECUTE ON FUNCTION set_config` works, but plain `SET` is a utility statement and walks around it. **A `SECURITY DEFINER` setter alone is therefore not a fix** — it secures the legitimate path and leaves the illegitimate one open.
3. `SET ROLE` **is** enforced by role membership. It is the only primitive PostgreSQL actually constrains, which is why per-tenant roles are the durable answer.
4. Re-pointing the tenant requires a **second statement**. In the installed `pg` 8.23.0, a stacked statement executes on the simple protocol but PostgreSQL refuses it on the extended protocol. **An empty `values: []` array is *not* enough to force the extended protocol** — `queryMode: 'extended'` is.

**Decision for feature 002 — three locks, all cheap:** revoke `set_config` from `hrms_app` (closes the single-statement path) · route every query through a wrapper that always sets `queryMode: 'extended'`, with a CI grep banning direct `client.query(` outside it (closes the stacked-statement path) · a `SECURITY DEFINER`, **write-once-per-transaction** `begin_tenant_session(uuid)` as the only granted way to set the variable (verified to persist to the caller's transaction, to refuse a second call, and to reset on commit).

**Deferred, and why it is not this feature's work:** per-tenant database roles with RLS keyed on `current_user` are stronger, and the cost is the connection topology, not the SQL — a shared pool must be a member of every tenant role to switch into them, which re-opens the hole, so it means a pool per tenant, per-tenant credentials, role creation inside provisioning, and connection growth linear in customers. That is a platform project with its own migration and rollback plan, and **it changes the multi-tenancy model, which is a one-way door in `CLAUDE.md` §7.**
**→ Needs the PM and the human before feature 002 ships, not after. Owner: hrms-fullstack-engineer.**
**Residual risk recorded:** the extended-protocol lock holds only while every query goes through the wrapper — one parameterless `client.query(sql)` in the request path re-opens it, which is why the CI grep is part of the control. Migrations and the owner role are outside all of it.

### 2026-08-26 — PM decision: the three locks are in feature 002's scope

**Decided by:** hrms-product-manager. This is a scope and sequencing call, which is mine. **The SQL is not mine and I am not ruling on it.**

**Decision: the three locks ship inside feature 002.** They are a precondition of the feature, not a follow-up to it.

**Why, in the terms this brief is written in.** `10-opportunity.md` lists "zero cross-tenant exposure" as a guardrail and says in as many words that it is **not a trade-off**. The alternative on offer is to ship this product's first public endpoints with a cross-tenant escalation that is known, reachable from day one, and cheap to close. There is no version of that I can write down in a brief and defend. The measured cost is one migration line, one query wrapper, one lint rule and about fifteen lines of plpgsql — **less work than the paperwork of deferring it properly would be**, which is the engineer's argument and it is correct.

**I am accepting the scope growth knowingly.** This makes feature 002 slightly bigger than the brief said. I am not cutting anything to compensate, because the locks are not a feature competing with the record view — they are the condition under which the record view is allowed to exist. `10-opportunity.md` is updated to say so rather than leaving the reader to infer it.

**One thing that must not be left as it is.** Feature 001's decision log records the mitigation for this hole as *"a `SECURITY DEFINER` setter or per-tenant roles would close this"*. The engineer has now demonstrated against a real PostgreSQL 16 that **the setter alone does not close it** — plain `SET` is a utility statement and walks around a revoked `set_config`. A log entry that records a fix which does not work is worse than one that records nothing, because the next person reads it and stops looking. This is the same shape as feature 001's `hasLegalHold()` defect: a control that was believed to be in place and was not.
**→ Action, owner hrms-fullstack-engineer: append a correction to `docs/features/001-core-hr-foundation/99-decision-log.md` pointing at this feature's findings.** Append, never edit — the wrong belief should stay visible in the history, with the correction underneath it.

### 2026-08-26 — PM position on per-tenant database roles — NOT DECIDED HERE

**This is a one-way door (`CLAUDE.md` §7 #1) and I am explicitly not deciding it.** `CLAUDE.md` requires the PM **and** the Full-Stack agent to sign off, and `docs/00-team-charter.md` escalates one-way doors to a human. What follows is a product position and a recommendation. It is not a decision, and nobody downstream should read it as one.

**My recommendation: not now.** Three locks now; per-tenant roles assessed as a named platform project, not started under this feature's schedule.

**The cost to customers, which is the part a product manager should be putting on the table.** The cost is not the SQL, it is the connection topology: a pool per tenant, credentials per tenant, role creation inside provisioning, and connection count growing linearly with customers. That is a **ceiling on how many tenants one deployment holds**, and it lands on `COST-01` (infrastructure cost per employee per month) for every customer — including the small ones who will never ask for isolation and would be paying for it. A 40-person startup tenant would carry the connection overhead of an isolation model it did not request.

**The cost to the roadmap, stated as a trade rather than a worry.** The realistic competitor for this engineering time is **feature 003** — the durable tracked request route for ex-employees, which carries an accepted `COMP-20` debt with a review date of **2026-11-30**. If per-tenant roles are taken now, 003 slips and that debt ages. **I would not make that trade**, and I want it recorded that the trade is what is actually being decided, not "should our database be more secure."

**What should trigger revisiting it**, and this is already half-written in feature 001's log: a customer contractually requiring isolation; **or** evidence that the CI grep is not holding in practice — a single parameterless query reaching the database outside the wrapper, found in review or in production, is the signal that the locks depend on discipline we do not have, and then roles stop being optional.

**→ Needs: hrms-fullstack-engineer's countersign, and a human decision, before feature 002 ships.**

**On where this decision should live.** `CLAUDE.md` §7 names `docs/99-decision-log.md` as the file where one-way doors are signed off. **That file does not exist.** Only per-feature logs do, and a one-way door recorded in `docs/features/002-…/99-decision-log.md` is a decision about the whole platform filed in a folder people stop opening once the feature ships. **Recommendation: create it, and make the human's ruling on per-tenant roles its first entry.** I have not created it myself — where cross-feature decisions live is a team-process call, not a PM artefact, and `docs/00-team-charter.md` does not assign it to anyone. It needs one line from the human saying it exists and who may append.

### 2026-08-26 — Q-20 resolved: national ID is not rendered in feature 002

**Decided by:** hrms-product-manager. Scope call, mine. **I agree with the engineer.**

**Decision: national ID is not shown on the record view and is not a field in the export.** Not masked, not blank, not present. The engineer checked and there is no encryption code anywhere in this product, nothing reads or writes the column, and it is always `NULL` — so the choice was never "masked or unmasked", it was "show Aisha four meaningless characters, or invent envelope encryption and key management inside a feature about a read-only screen."

**What Aisha sees instead: nothing at all.** Not an empty row labelled "National ID". An empty labelled row is worse than absence — it invites *"why is mine blank?"*, and the honest answer is "the field is not used yet", which is not a sentence a screen should have to carry.

**The constraint I am putting on the export copy, because it is the one place this could go wrong.** The export answers a statutory right. **No wording in it may imply we hold something we do not hold, and none may imply we hold it and are withholding it.** Today the truthful statement is *not collected* — not *"held, not shown"*, and not *"contact the DPO to obtain it"*, because there is nothing to obtain. A right-of-access response is the worst possible place for a false statement about what we hold. The exact wording of `RULE-012`'s `not_included` section is the BA's; that constraint is mine. → **hrms-business-analyst.**

**Nothing is lost from the ★ wow moment.** The wow is the access log — who looked, when, and why. No part of the experience spine in `10-opportunity.md` touches national ID. This costs the feature nothing a user would notice.

**Two consequences recorded rather than left implied:**
1. **`SEC-04` needs its own design and its own feature** — envelope encryption, key rotation, key management, and a separately stored non-secret "last 4" if masking is genuinely wanted. Added to the deferred table in `10-opportunity.md` with an owner. **It is not deferred silently.**
2. **Migration 0001 line 79 asserts `SEC-04` in a comment describing a control that was never built.** An auditor reads that comment as evidence. It is the same failure mode as feature 001's green test on `hasLegalHold()`. **→ Action, owner hrms-fullstack-engineer: correct or remove that comment in this feature, since migrations are already being touched.** I am not specifying the wording; I am saying a comment claiming a control we do not have must not survive this release.

### 2026-08-26 — Q-21: PM answers only the product question, and passes the mechanism back

**Not my decision.** REQ-014's "same transaction" is an implementation decision with a compliance consequence. It belongs to hrms-fullstack-engineer, with hrms-techno-functional-reviewer as the gate. **I am not ruling on transactions, streaming or connection pinning, and this entry should not be cited as if I had.**

**The one question that is mine — does the product promise change?** The promise is *"every time your data is accessed or exported, we record it."*

**It still holds, and it holds slightly better.** Committing the audit entry **before** the first byte can only ever **over**-record: an entry may exist for an export that then failed mid-stream. It can never **under**-record. The opposite ordering has the opposite failure: data leaves the building and the trace does not survive. **From Aisha's side the promise was never "the trace and the bytes are atomic" — it is "nothing is read without a trace."** Over-recording is the safe direction, and it is the direction that keeps the promise true.

**One product constraint attaches, and it is the only thing I am adding.** If an entry can exist for an export that failed, then **the access log must not present a failed export as a completed download.** Aisha reading *"you downloaded your data on 26 Aug"* for a file she never received will phone HR, and she will be right to. The engineer already records the outcome on `export_artefact`; my requirement is that whatever Aisha sees distinguishes the two. → **hrms-business-analyst** for the wording, **hrms-fullstack-engineer** for the mechanism.

**Everything else about Q-21 goes back to the engineer, with the reviewer as the gate.**

### 2026-08-28 — RULE-001 divergence approved: a broken system says "broken", not "switched off"
**Raised by:** hrms-fullstack-engineer, during slice 2, as a considered divergence rather than an oversight.
**Approved by:** the human, 2026-08-28.

**What the rule said.** RULE-001: if the setting store cannot be read, treat the feature as off and return 403.

**Why that is wrong.** A 403 renders the "your organisation has not turned this on" screen. That sentence is a statement about the employer's choice. When the truth is that our own store is unreachable, the sentence is false — we would be telling Aisha her employer switched something off when her employer did nothing of the kind. It is a small lie told at scale, on the one screen whose entire purpose is that the company is being straight with her.

**Decision.** The failure propagates as a 503 "something went wrong, try again" instead. The safety property RULE-001 exists to protect is preserved — an unreadable setting NEVER grants access — but the reason shown to the employee is true.

**The distinction worth keeping.** Fail-closed is about *access*: when we do not know, nobody gets in. It is not about *explanation*: when we do not know why, we must not invent a reason. RULE-001 conflated the two. This separates them.

**Consequences:**
- The BA should reflect this in RULE-001 rather than leaving the requirement and the code disagreeing. Raised as a note to hrms-business-analyst, non-blocking.
- The reviewer sees a deliberate, approved divergence, not a defect.
- `settings.ts` already propagates rather than swallowing the error; no code change needed.

### 2026-08-28 — Q-19 resolved: readable tenant sign-in addresses
**Decided by:** the human, 2026-08-28, after the trade was put to them twice.
**Decision:** the tenant sign-in address is **readable** — `northwind.<product>.app`, not an opaque random slug. Security is enforced inside the application: the tenant setting, the permissions model, RLS, and the audit trail. None of those change.

**What was traded away, recorded so nobody re-argues it from scratch.** A readable address is enumerable. Not "the customer list can be downloaded" — the accurate statement is **"any company can be confirmed or denied, in bulk, by anyone."** Two routes, neither needing anything from us:
1. Guessing from a candidate list — an industry, a competitor's clients, a public company index — automated.
2. **Certificate Transparency.** Every publicly-trusted TLS certificate is written to public searchable logs by design. A per-tenant certificate publishes the tenant's name there within minutes.

**The human's reasoning, recorded as given:** there is no shared tenant picker and no common login page; each customer is handed its own URL directly. That is true and it removes the *convenience* route, but not the *guessing* or *certificate-log* routes, because neither depends on us publishing anything. The decision was reaffirmed with that understood.

**Why this is a legitimate call, not a lapse:** whether the customer list is commercially sensitive is a business judgement, not a security one. No employee's personal data is exposed by an enumerable address. Widely-used business software makes the same choice.

**Two mitigations that preserve readable addresses, offered and NOT taken now:**
- **A single wildcard certificate** rather than one per tenant. Closes the Certificate Transparency route entirely. A deployment setting, not code. **Recommended when this ships to a real domain.**
- **A uniform pre-authentication response**, so an unknown address is indistinguishable from a real one. Closes the guessing route. **This one has a design consequence:** REQ-031's closed-window page renders *that tenant's* data-protection contact to an unauthenticated caller, which is only safe if the address is already known to be real. Adopting it later means REQ-031 needs re-deriving.

**Consequence for the build:** migration 0006's opaque slug is not what ships. The address carries a readable tenant identifier. `resolveRequestContext` still takes the tenant from the request host, so a subject from another customer still resolves to nothing — that property is unaffected.

### 2026-08-28 — Q-19 IMPLEMENTED: migration 0006 rewritten, opaque slug deleted
**By:** hrms-fullstack-engineer, slice 3c, carrying out the human's ruling of the same day.

`packages/db/migrations/0006_tenant_signin_slug.sql` — the opaque 32-hex-character slug —
was **deleted, not amended**. It had never been committed and never applied anywhere. In
its place, `0006_tenant_signin_address.sql`: `tenant.signin_slug` is a readable DNS label,
`northwind`, backfilled from the tenant name.

**Three choices inside it that were mine, recorded because they are not in the ruling:**

1. **No database default on the column.** A `DEFAULT` would hand every tenant — existing
   and every future one — an address nobody chose. Provisioning must state one, and a
   missing slug is a loud failure at provisioning time rather than a surprising address
   a customer discovers. The consequence is real and landed immediately: the test fixture
   in `packages/core/test/setup.ts` broke and had to be updated, because the fixture *is*
   provisioning.
2. **Uppercase is refused by CHECK, not folded.** Host names are case-insensitive, so
   storing `Northwind` and `northwind` as two rows would be two tenants sharing one
   address, and the UNIQUE constraint would not see it. The resolver folds the *input*
   instead, so an employee who types a capital letter still arrives.
3. **A reserved-label list** (`www`, `api`, `admin`, `auth`, `login`, …). A customer
   called "API" taking `api.<product>.app` would shadow our own address space, and the
   failure would look like an outage rather than a naming collision.

**What is unchanged by the ruling and worth restating:** `tenant_id_for_signin_slug` is
still `SECURITY DEFINER`, `STABLE`, fixed `search_path`, and returns **one uuid and
nothing else** — no name, no region, no row, no listing. The ruling accepted that the
address space is enumerable *from outside*; it did not make the customer list readable
*from inside*, and an application role compromised through an injection defect still
learns only one yes/no answer at a time. There is a test asserting the application role
reads exactly one row from `tenant` and cannot change a `signin_slug`.

The migration was applied forward, rolled back and re-applied on postgres:16, including
the label-collision path. Unlike the opaque slug, a re-run reproduces the **same** address
for an unchanged name; the rollback note says so, and says that a slug set by provisioning
to something other than the derived label is not recoverable and must be copied out first.

### 2026-08-28 — Sign-out goes to Keycloak WITHOUT `id_token_hint`, and why that is a cost not a shortcut
**By:** hrms-fullstack-engineer, slice 3c. **Non-blocking. Raised so it is not discovered later.**

Sign-out clears our cookie **and** redirects to the issuer's `end_session_endpoint`, which
is what the design note promised. It sends `client_id` and `post_logout_redirect_uri`, and
**not** `id_token_hint`.

**Why not:** we do not keep the ID token. The session cookie carries `{ sub, iat, sid }`
and nothing else — the property REQ-016 and REQ-022 rest on — and there is no server-side
session store yet to put a token in. Putting the ID token in the cookie to make sign-out
tidier would trade a requirement for a convenience.

**What it costs Aisha:** without the hint, an issuer typically asks the person to confirm
the sign-out rather than performing it silently. Sign-out still ends the Keycloak session;
it takes one extra tap. `[UNVERIFIED — this is Keycloak's documented behaviour as I
understand it, not something I have observed. Confirm against the deployed realm.]`

**The fix, and it is not extra work:** a server-side session record keyed on `sid`, which
`SEC-09`'s 12-hour and 30-minute lifetime enforcement needs anyway. One piece of work,
scheduled for slice 3d. Recorded rather than hidden behind a working-looking redirect.

### 2026-08-28 — Sign-out is a `public` route, deliberately
**By:** hrms-fullstack-engineer, slice 3c. **A judgement call the reviewer should check.**

`POST /signin/out` declares `auth: 'public'`. Sign-out has to work for a session we cannot
read — expired, sealed with a rotated key, belonging to somebody whose identity link was
disabled this morning. Requiring `employee` would mean the people most likely to need to
sign out, on a shared machine with something already wrong, are exactly the ones who
cannot.

**The cost:** a cross-site request can force somebody to be signed out. That is a
nuisance, not a disclosure — the route returns no data and grants nothing. It is
`POST`-only so a bare `<img>` tag cannot trigger it, and `SameSite=Lax` withholds the
session cookie from a cross-site form post, so the forced sign-out does not even reach a
session. **If the reviewer disagrees, the change is one line plus a "sign out anyway"
path for unreadable sessions**, and I would rather be argued out of it than have it pass
unnoticed.

### 2026-08-28 — NOT VERIFIED AGAINST KEYCLOAK, and this must not be read as done
**By:** hrms-fullstack-engineer, slice 3c. **Recorded at the human's instruction.**

The whole sign-in flow is tested against a **synthetic issuer** — our own signing key,
JWKS and discovery document — and never against a real Keycloak. That was deliberate and
I agree with it: every attack worth testing needs an issuer that will misbehave on demand,
and a real Keycloak will not mint an `alg: none` token, sign with the wrong key, or echo
last week's nonce.

**So "sign-in works" means "the relying-party logic is correct against a conforming issuer
and refuses a hostile one". It does not mean sign-in works against our identity provider.**
The unverified list is in the design note under *What is not verified*; the two most
likely to bite on day one are **the discovery document's `issuer` matching ours exactly,
trailing slash included** (we refuse a mismatch, correctly, and it is a plausible first
failure) and **reading the `Host` header behind a proxy** — a trusted-proxy decision is
required before this is deployed, or a rewritten `Host` resolves the wrong tenant or none.

### 2026-08-28 — The route descriptors were never enforced. Closed in slice 3d.
**Found by:** the coordinator, reviewing slice 3c. **Fixed by:** hrms-fullstack-engineer.

**The gap.** `RouteAccess` was declared per route and checked AT BOOT for existence. Nothing
applied it per request. A route could declare `auth: 'employee', tenantSettingGated: true`
and serve the entire internet, and all 237 tests would have stayed green — every test was
about the descriptor's *presence*, none about its *effect*.

This is the fourth instance of the same shape in this product: feature 001's
`hasLegalHold()`, feature 001's `TENANT_SCOPED` list, migration 0001's `SEC-04` comment, and
now this. **A control that is believed to be in place and is not.** Recorded here rather than
only in the design note, because the pattern is the finding.

**Closed by** `decideRouteAccess` in `packages/core/src/access-control.ts` (pure, framework-
free, enumerable) plus `guarded()` in `apps/web/src/guard.ts`, which every handler is wrapped
in and which reads the descriptor **from the manifest**, never from an argument the route
supplies. A test imports every route module and asserts the exported handler IS the wrapped
one, so a route cannot quietly stop being gated.

### 2026-08-28 — An unreadable store outranks "who are you" — extending the RULE-001 divergence
**By:** hrms-fullstack-engineer. **Non-blocking, but it extends an approved ruling and the
reviewer should confirm I read it correctly.**

The human ruled on 2026-08-28 that an unreadable *setting store* must give 503, not 403,
because a 403 tells Aisha her employer switched something off when the truth is that we are
broken.

**The same argument applies one step earlier, and I have applied it.** The per-request
resolution is ONE query answering both *who is this* and *what does the setting say*. When
it fails, both answers are missing — so a 401 "you are not signed in" is the same lie in a
different costume, and a worse one, because Aisha would go and reset a password that was
never wrong. So an unreadable resolution returns **503 before the authentication check**.

**Scoped, deliberately:** only for routes that actually needed the lookup. A public, ungated
route — the health check, the sign-in redirect — asks the database nothing and keeps working
during an outage. A liveness probe that fails when the database is down reports the wrong
outage.

**If the reviewer thinks this over-reads the ruling**, the change is one condition, and I
would rather be argued out of it than have it pass unnoticed.

### 2026-08-28 — `hr_admin` routes deny everybody, because roles are not resolved yet
**By:** hrms-fullstack-engineer, slice 3d. **A gap, stated rather than papered over.**

Nothing in this product resolves roles from the database. `AccessPrincipal.roles` is an empty
set on every real request, so a route declaring `auth: 'hr_admin'` refuses everyone.

**This is the intended behaviour until role resolution ships**, and it fails in the safe
direction: the first admin route to be built will be refused for everybody, loudly, on its
first test. The alternative — treating an unresolvable role as satisfied — is how an
administrative endpoint ships open.

There is a passing test asserting it, with a positive control proving the same shape IS
allowed when the role is present, so the empty set cannot be mistaken for a function that
denies everything.

### 2026-08-28 — `/api/me/record` refuses every ex-employee, which is narrower than REQ-022
**By:** hrms-fullstack-engineer, slice 3d. **A knowing divergence from the requirement, in
the safe direction. Owner of the fix: whoever builds post-exit routing.**

REQ-022 grants an ex-employee 90 days of access to a minimal view of this route. **The window
is not built** — post-exit routing was out of this slice's scope — but the `postExit`
descriptor had to be enforced or it would have been half-real.

So `/api/me/record` declares `postExit: false` and **every exited session is refused,
including on day 1.** Refusing somebody the requirement would admit is a bug to fix;
admitting somebody it would refuse is a breach. This is the safe half of that pair.

**Request to the Test agent, recorded so it is not lost:** write this as a FAILING acceptance
test against REQ-022, not a passing one against my implementation. A gap encoded as a green
test is a gap nobody fixes.

### 2026-08-28 — A latent cursor bug in the history read model, found by seeding an overflow
**By:** hrms-fullstack-engineer, slice 3d. **Recorded because of how it was caught, not
because of what it was.**

The history cursor was read off the raw PostgreSQL row (`rows[n].decidedAt`) instead of the
mapped entry. PostgreSQL returns snake_case, so it was always `undefined`, and the `?? null`
swallowed it. **The cursor was silently always null** — which reads as "no more pages" and
would have truncated every long change history at 25 entries, with no error anywhere and no
symptom until an employee with a long career said "my history stops in March".

It was caught because the test **seeds 30 rows and asserts a real second page**, rather than
asserting the page-size constant. A test written against the constant would have agreed with
the bug. This is the same lesson as the vacuous-assertion sweep: assert the business fact,
never the derivation the production code uses.

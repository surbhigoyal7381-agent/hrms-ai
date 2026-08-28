---
feature: 002-employee-self-service-record-view
artefact: design-notes
author: hrms-fullstack-engineer
date: 2026-08-26
status: draft
inputs: [20-requirements.md, 10-opportunity.md, 99-decision-log.md]
---

# Design notes — Employee self-service record view and history

**Tier: L (system).** This is not a screen. It is the first transport layer in the product —
the first HTTP endpoint, the first session, the first login, the first thing on the public
internet. Feature 001 built a database and some domain functions that nothing can call. This
builds the part that can be attacked.

I have written this note against code I read and behaviour I tested on a real PostgreSQL 16 and
the `pg` version this repo actually installs. Where I ran an experiment, the output is pasted.
Where I could not verify something, it says so.

---

## What I am building, in one paragraph

Aisha signs in on her phone and opens one screen that shows what her employer currently holds
about her, every change ever made to it with the reason and the person who decided, any change
that has not taken effect yet, and — the point of the whole feature — a list of who has opened
her record and why. She can correct six of her own fields without asking anyone, and download
everything in one JSON file. Whether she sees the middle three things is one organisation-level
switch that is **off until somebody turns it on**; the download, a minimal view of her own
fields, and the data-protection contact work regardless, including for ninety days after she
leaves. Everything she reads writes an entry to the audit log, whether or not she is allowed to
read it.

---

## First: the two questions that blocked the BA

### Q-12 — `audit_log.actor_id`: confirmed a real defect, now fixed

**The BA's assumption was wrong, and the consequence was live.** `Principal.actorId` and
`Principal.employmentId` were separate fields holding different values. `employment.ts` wrote
`actorId` into `audit_log.actor_id`, `analytics_event.actor_id` and
`transparency_ledger.decided_by`; `erasure.ts` matched those columns against `employment.id`.
They never met. Reproduced on postgres:16 through the shipped code path:

```
audit rows that exist:                        1
rows the erasure predicate matched:           0
after erasePerson — rows still naming actor:  audit 2, ledger 1, analytics 1
                                              ledger names NOT replaced: 1
```

Fixed before starting this note. `actor_id` and `decided_by` now mean `employment.id`, enforced
by composite foreign keys `(tenant_id, column) REFERENCES employment (tenant_id, id)` in
`packages/db/migrations/0002_actor_is_an_employment.sql`, and by a single non-null branded
`actorEmploymentId` on `Principal`. Details in `docs/features/001-core-hr-foundation/99-decision-log.md`,
entry of 2026-08-26.

**Why this matters here and not only there.** REQ-020 asks the access log to name a viewer who
has since left or been erased. That only works if erasure can *find* the viewer's rows. It could
not. The access log would have been built on a join that silently matched nothing — and the
obvious test for it would have compared zero to zero and passed, which is exactly what happened
in feature 001. The access log is now safe to build on `actor_id`.

**Second thing the fix changed, which the BA should know:** every principal in the old test suite
shared one `actorId`, so a change Rohan made was recorded as decided by HR under a test named
*"the accountable human cannot be forged"*. `transparency_ledger.decided_by` now names the person
who actually acted. REQ-003's *"who decided"* column is only truthful because of that fix.

### Q-13 — how a corrected reason supersedes the original without breaking append-only

**Recommendation: a self-referencing pointer carried by the NEW row, never a write to the old one.**

Add `supersedes_ledger_id uuid REFERENCES transparency_ledger(id)` to `transparency_ledger`. A
correction inserts a **new** row whose `supersedes_ledger_id` points at the row it replaces for
display. Nothing about the original row is touched, so `REVOKE UPDATE` stands unchanged and no
new column grant is needed — which is the part that makes this better than the alternatives.

The read path renders rows that are not pointed at by any live successor:

```sql
SELECT l.* FROM transparency_ledger l
 WHERE l.subject_employment_id = $1
   AND NOT EXISTS (SELECT 1 FROM transparency_ledger s
                    WHERE s.supersedes_ledger_id = l.id)
```

**Worked example.** Rohan writes reason *"Moving you off settlements while we look into Rakesh's
complaint"* — ledger row `L1`, 22 Aug. The DPO determines it names a third party and appends `L2`
with reason *"Moving you off settlements while a process is under way"* and
`supersedes_ledger_id = L1`. Aisha's history shows `L2` plus the line
`history.reason_corrected` ("Corrected on 26 August 2026"). `L1` still exists, still readable by
HR and the DPO, still immutable. An auditor can reconstruct both.

**Rejected:** a `superseded_for_display boolean` on the original row — needs `GRANT UPDATE` on a
column of an append-only table, which is the pattern feature 001 deliberately kept to the two
places it could justify. A pointer on the new row needs no grant at all.

**Constraint worth having:** a chain must not fork. `CREATE UNIQUE INDEX ON transparency_ledger
(supersedes_ledger_id) WHERE supersedes_ledger_id IS NOT NULL` — two rows claiming to supersede
the same original is a bug that would render both or neither.

---

## Requirement IDs covered

**Built:** REQ-001 · REQ-002 · REQ-003 · REQ-004 · REQ-005 · REQ-006 · REQ-007 · REQ-008 ·
REQ-009 · REQ-010 · REQ-011 · REQ-012 · REQ-013 · REQ-014 · REQ-015 · REQ-016 · REQ-017 ·
REQ-018 · REQ-019 · REQ-020 · REQ-021 · REQ-022 · REQ-023 · REQ-024 · REQ-025 · REQ-026 ·
REQ-027 · REQ-028 · REQ-029 · REQ-030 · REQ-031.
**Rules:** RULE-001 … RULE-013 in full; RULE-014 partially — see *What I am not building*.

**Two I am flagging as not buildable as written** — REQ-002's masked national ID, and REQ-014's
"same transaction" for the export. Both are in *Problems in the requirements*, with proposed
answers, raised as questions rather than decided by me.

---

## Simplicity check (Gate 0, `docs/02-definition-of-done.md`)

**1. What does this complexity buy?** Three things, each nameable.
*The transport layer* buys the existence of any user interface at all; there is no cheaper
version. *The per-request authorisation resolution* (no cached flag, no claim in a token) buys
the property that Priya switching the setting off at 11:02 takes effect at 11:03 — REQ-016 —
rather than whenever a token expires. *The route manifest* buys the property that a route added
in feature 004 is unreachable from a post-exit session by default, which is the difference
between REQ-022 holding and REQ-022 decaying.

**2. Simplest version delivering 80%?** A read-only profile page with no history and no access
log. It is 80% of the screens and 0% of the differentiator, and every competitor already ships
it. Explicitly not shipping it — the PM's brief says so and I agree.

**3. Can Aisha complete the main action in under 10 seconds on her phone?** Her main action is
reading: interactive under 2.0s, budgeted in *PERF-01* below. Correcting her phone number: under
10s, and it is one form field and one button.

**4. What did we deliberately leave out?** The list in *What I am not building*, with reasons.
It is long, and it includes three things the requirements specify that I am proposing to defer.

**Complexity I considered and rejected as unbought:** a cache in front of the tenant setting
(saves ~1ms, costs a stale permission); a materialised rollup table for access-log grouping
(build it when a measurement demands it, not before); per-tenant database roles (assessed in
detail below — the cost is real and the cheaper control closes the same hole).

---

## The transport layer — the part that is actually new

### Package layout

```
apps/web/                     Next.js App Router. Server-rendered. The only thing on the internet.
  app/(employee)/record/      the record view, history, access log  — server components
  app/api/…                   the JSON endpoints listed under API surface
  app/signin/…                OIDC start / callback / the closed-window page
  src/session.ts              cookie read/write. Identity only. No authorisation claims.
  src/route-manifest.ts       every route + its access descriptor. Boot fails if one is missing.
  src/request-context.ts      resolves principal + tenant + setting, per request, from the DB
packages/core/src/            unchanged domain functions, plus new read models
  record-view.ts              current values, history, access log queries
  self-correct.ts             the allowlist enforcing function (REQ-009)
  export.ts                   RULE-012 export assembly, streamed
  settings.ts                 tenant setting resolution (RULE-001)
packages/db/migrations/0003_*.sql
```

`apps/web` holds no SQL. Every database call goes through `packages/core`, because that is where
`withTenant` and the policy functions live and where the audit write is not optional.

### Session and authentication

**Keycloak, OIDC authorization code flow with PKCE** (`docs/06-technology-decisions.md` — Keycloak
is the decided identity provider). *OIDC is the standard sign-in protocol; PKCE is the extension
that stops an intercepted authorization code from being redeemed by somebody else.*

The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, encrypted, and contains **one thing**:

```json
{ "sub": "<keycloak subject>", "iat": 1756200000, "sid": "<opaque session id>" }
```

**No tenant id. No employment id. No roles. No setting state. No post-exit flag.** Every one of
those is resolved from the database on every request. This is not caution for its own sake — it
is what REQ-016 and REQ-022 literally require ("the setting is evaluated from the store on every
request and is never read from a session claim, a cached flag, or a JWT"; "the window is
evaluated per request against the exit date, never from a claim baked into the token"). If a
value is not in the cookie, it cannot be stale and it cannot be forged.

**Cost of that choice, measured not assumed:** one extra indexed lookup per request that resolves
`sub → person → employment → tenant`, joined with the setting row. It is a single query, not
four — see *Per-request resolution* below. Budgeted at under 5ms; the requirement allows 50ms.

**Session lifetime** is bounded (`SEC-09`): 12 hours absolute, 30 minutes idle, and a sign-out
that revokes at Keycloak, not just locally. `[ASSUMPTION]` those numbers are mine and not in the
requirements; they are parameters, and the Test agent should hold me to them being configurable.

### Per-request resolution — one query, four answers

```sql
-- resolve_request_context($1 = keycloak subject)
SELECT p.id                AS person_id,
       e.id                AS employment_id,
       e.tenant_id,
       e.status,
       e.exit_date,
       t.region,
       s.record_view_enabled,
       COALESCE(wl.timezone, t.default_timezone) AS work_timezone
  FROM identity_link il
  JOIN person p       ON p.id = il.person_id
  LEFT JOIN employment e ON e.person_id = p.id AND e.status <> 'cancelled'
  JOIN tenant t       ON t.id = p.tenant_id
  LEFT JOIN LATERAL (SELECT record_view_enabled
                       FROM tenant_record_view_setting
                      WHERE tenant_id = p.tenant_id
                      ORDER BY changed_at DESC LIMIT 1) s ON true
  LEFT JOIN LATERAL (…work calendar…) wl ON true
 WHERE il.subject = $1
```

Four things fall out of one round trip: **who**, **which tenant**, **is the record view on**, and
**where in the exit lifecycle**. `record_view_enabled` arriving as SQL `NULL` — no row — is
RULE-001's "unset", and the resolver maps `NULL → false` at exactly one place.

`identity_link` is a new table mapping a Keycloak subject to a `person`. It is needed because
nothing today connects an authenticated user to an employee. **It is in migration 0005.**

> **Correction, 2026-08-28.** This paragraph previously said "It is in migration 0003." That was
> wrong — 0003 never contained it, and by the time anyone read the sentence 0003 was committed and
> could not be edited. Corrected here rather than quietly, because the next reader would otherwise
> have gone looking for a table that was not there and concluded the schema was broken.

**Two corrections to the query above, found when building it rather than when writing it:**

1. **`t.default_timezone` and the work-calendar lateral join do not exist.** There is no timezone
   column on `tenant` and no work-calendar table anywhere in this product. The resolution therefore
   returns the four answers it actually has — who, which tenant, is the record view on, where in
   the exit lifecycle — and **timezone resolution is deferred** to the slice that needs it. The
   access log already takes the timezone as a parameter, so nothing is blocked. RULE-009's fallback
   ("use the tenant default and say which") still needs that column; it is not built yet.

2. **The lookup cannot run inside an ordinary tenant transaction**, because the tenant is one of
   the things it resolves. `withTenant` needs a tenant before it opens. Resolved by taking the
   tenant from the request host — the sign-in address is already tenant-specific for REQ-031 — and
   resolving the subject *within* that tenant. A subject belonging to another tenant then resolves
   to nothing, which is the correct answer and a stronger one than a global lookup would give.
   `withTenantForResolution` exists for that one step and grants **no actor**, so nothing that
   requires an `Actor` — every audit write — can be done from it.

### The route manifest — how REQ-022's allowlist avoids rotting

REQ-022 says any endpoint reachable from a post-exit session that is not one of three is a
**blocker**. The requirements also say, correctly, that a denylist decays the first time somebody
ships a route and forgets. Feature 001 has the scar: a hand-written `TENANT_SCOPED` list that
omitted the `tenant` table itself and survived 28 passing tests.

So the allowlist is not a list a human maintains. Every route module must export a descriptor:

```ts
export const access: RouteAccess = {
  auth: 'employee',              // 'public' | 'employee' | 'hr_admin'
  tenantSettingGated: true,      // false only for the carve-out
  postExit: false,               // default; three routes set true
};
```

Two enforcement points, both of which fail loudly rather than quietly:

1. **A boot-time check** walks the `app/` directory, collects every route file, and refuses to
   start the server if any route has no `access` export. A route with no descriptor is not
   "public by default" — the process does not come up.
2. **One middleware** reads the descriptor and applies it. No route does its own gate check, so
   there is no route that forgot to.

The test enumerates routes **from the same filesystem walk**, not from a hand-written list, and
asserts exactly three have `postExit: true`. A route added in feature 004 fails that test on the
day it is added.

**Honest limitation:** this protects routes under `app/`. It does not protect a future
non-Next.js service. If one appears, it needs its own manifest or this control is bypassed —
recorded here so nobody assumes it is global.

---

## The `app.tenant_id` hole — what PostgreSQL actually permits

Feature 001 accepted this as open debt on the reviewer's note that it was theoretical, *"because
until this feature there was no HTTP endpoint to inject into."* **This feature ships the
endpoints.** `FORCE ROW LEVEL SECURITY` does not help: the attacker does not bypass the policy,
they satisfy it as somebody else.

The decision log names two candidate fixes. I tested both against a real PostgreSQL 16 rather
than reasoning about them, because the answer turned out to be the opposite of what I expected.

### What I ran, and what came back

**1. Can the application role set the tenant variable itself? Yes, trivially.**

```
$ psql -U probe_app -c "SET app.tenant_id = '3333…'; SHOW app.tenant_id;"
SET
33333333-3333-3333-3333-333333333333
```

**2. Can that be revoked? No — and the revoke *appears to succeed*, which is the trap.**

```
$ psql -U postgres -c 'REVOKE SET ON PARAMETER "app.tenant_id" FROM PUBLIC;'
REVOKE
$ psql -U postgres -tAc "SELECT parname, paracl FROM pg_parameter_acl;"
                                   ← empty. No ACL row was created.
$ psql -U probe_app -c "SET app.tenant_id='6666…'; SHOW app.tenant_id;"
SET
66666666-6666-6666-6666-666666666666
```

I also tried `ALTER DATABASE … SET app.tenant_id` first, in case defining the parameter made it
ACL-controlled. It does not. **`GRANT`/`REVOKE SET ON PARAMETER` does not constrain a custom
placeholder variable in PostgreSQL 16.** Anybody who "fixes" this with a `REVOKE` and does not
check `pg_parameter_acl` will believe they have closed it.

**3. Does revoking `set_config()` help? Partly — and only partly.**

```
$ psql -U postgres -c "REVOKE EXECUTE ON FUNCTION set_config(text,text,boolean) FROM PUBLIC;"
REVOKE
$ psql -U probe_app -c "SELECT set_config('app.tenant_id','4444…',false);"
ERROR:  permission denied for function set_config
$ psql -U probe_app -c "SET app.tenant_id='5555…'; SHOW app.tenant_id;"
SET                                ← plain SET is a utility statement, not a function call
55555555-5555-5555-5555-555555555555
```

**So a `SECURITY DEFINER` setter on its own is not a fix.** It makes the legitimate path safe and
leaves the illegitimate one wide open. That is the finding I most want on the record.

**4. `SET ROLE` *is* enforced — this is the one primitive that genuinely constrains.**

```
$ psql -U probe_app -c "SET ROLE tenant_a; SELECT current_user;"   ← member
SET
tenant_a
$ psql -U probe_app -c "SET ROLE tenant_b; SELECT current_user;"   ← not a member
ERROR:  permission denied to set role "tenant_b"
```

### The step that changes the answer: how the attacker would have to do it

To re-point the tenant, an injected payload must execute `SET app.tenant_id = …` — **a second
statement**. So I tested whether a second statement is reachable through the `pg` client this
repo installs (`pg` **8.23.0**, from `packages/core/node_modules/pg/package.json`):

```
stacked, NO params  : ALLOWED -> ["SELECT","SET"]
stacked, WITH params: BLOCKED -> cannot insert multiple commands into a prepared statement
```

PostgreSQL itself refuses multiple commands in a prepared statement. But the guard is thinner
than "always pass parameters", and this is the detail that would have been got wrong:

```
params = []           : ALLOWED (simple protocol)   ← an empty array is NOT enough
params = undefined    : ALLOWED (simple protocol)
config obj, values[]  : ALLOWED (simple protocol)
queryMode 'extended'  : BLOCKED -> cannot insert multiple commands into a prepared statement
```

`queryMode: 'extended'` exists in the installed version — I read it in
`packages/core/node_modules/pg/lib/query.js` (`requiresPreparation()` returns true for it) and
confirmed the behaviour above. A query with **zero** parameters still uses the simple protocol
unless that option is set.

And the single-statement variant is closed by step 3:

```
in-statement set_config: BLOCKED -> permission denied for function set_config
```

### Recommendation — three locks, and they are cheap

| Lock | What it stops | Cost |
|---|---|---|
| `REVOKE EXECUTE ON FUNCTION set_config(text,text,boolean) FROM hrms_app` | Changing the tenant **inside one statement** (`SELECT … UNION SELECT set_config(…)`) — no stacking needed | One migration line |
| **Every query goes through the extended protocol** — a `query()` wrapper in `packages/core/src/db.ts` that always sets `queryMode: 'extended'`, plus a CI grep banning direct `client.query(` outside it | Changing the tenant with a **stacked second statement**. This is the escalation path | A wrapper and a lint rule |
| **`begin_tenant_session(uuid)`, `SECURITY DEFINER`, write-once per transaction** — the only granted way to set the variable | An accidental or malicious *re-set* on the legitimate path, and it makes the tenant immutable for the life of the transaction | ~15 lines of plpgsql |

I verified the third one behaves as needed, because plpgsql GUC scoping is easy to get wrong:

```
does a SECURITY DEFINER function's set_config persist to the caller's transaction?
  aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa          ← yes
is it write-once within the transaction?
  ERROR:  tenant already set for this transaction (aaaaaaaa-…)
does it reset between transactions (pooled-connection safety)?
  <empty>                                        ← yes
```

Together these mean: on the legitimate path the tenant is set once and cannot be changed; on an
injected path there is no way to reach either the function or the statement that would change it.

### Should this be in feature 002? Yes — the three locks. No — per-tenant roles.

**The three locks belong in this feature**, because this feature is what makes the hole
reachable. They are a migration line, a wrapper and a lint rule; deferring them to "a separate
piece of work" would mean shipping the first public endpoints with a known cross-tenant
escalation path open, and the mitigation is smaller than the paperwork of deferring it.

**Per-tenant database roles are a genuinely stronger fix and they are not this feature's work.**
`SET ROLE` is the only primitive PostgreSQL actually enforces, so the durable answer is RLS
policies keyed on `current_user` with the connection authenticated as a tenant role. The cost is
not the SQL — it is the connection topology. A shared pool must be a member of every tenant role
to switch into them, which re-opens the hole; so it means a pool per tenant, credential
management per tenant, role creation inside tenant provisioning, and connection-count growth that
is linear in customers. That is a platform project with its own migration and its own rollback
plan, and doing it badly under this feature's schedule would be worse than doing it later
deliberately.

**So: locks now, roles as a named follow-up.** I am recording it as a decision-log entry for the
PM and the human rather than closing it myself, because the multi-tenancy model is a one-way door
in `CLAUDE.md` §7 and per-tenant roles change it.

**Residual risk, stated plainly.** The extended-protocol lock holds only while every query goes
through the wrapper; a single `client.query(sql)` with no parameters anywhere in the request path
re-opens it, which is why the CI grep is part of the control and not a nicety. Migrations and the
owner role are outside all of this — they connect as `postgres` and always could set anything.
And none of it defends against a defect that leaks data *within* one tenant; RLS was never
supposed to.

---

## REQ-031 — making three different people get the same answer

Three fixtures must be indistinguishable: **A**, a real ex-employee on day 91; **B**, somebody
who never worked here; **C**, somebody who was erased. The BA is right that the natural shape —
*look them up, and if found, compute the window, and if closed, render* — leaks through timing,
and right that saying "show generic text" does not meet the requirement.

The design has four independent parts. Only one of them is about the words on the page.

### Part 1 — the same work, in the same number of round trips

Timing on a request like this is dominated by **database round trips**, not by CPU. Two paths
that do the same arithmetic but one round trip apart differ by a whole network hop, which is
enormous compared to the 5ms threshold. So the invariant is stated in round trips, not in
branches:

**Every closed-window request performs exactly four statements, in the same order, always.**

| # | Statement | Case A (real leaver) | Case B (never existed) | Case C (erased) |
|---|---|---|---|---|
| 1 | Resolve the submitted identifier | returns 1 row | returns 0 rows | returns 0 rows (identity link deleted on erasure) |
| 2 | Compute window state for a subject | the real `exit_date` | a **sentinel** subject | sentinel |
| 3 | Load the tenant's DPO contact | tenant row | **the same tenant row** | the same tenant row |
| 4 | Write the audit entry | names the person | anonymous | anonymous |

Statements 2 and 4 run against a sentinel when statement 1 found nothing. The sentinel is a real
row in a `probe_subject` table seeded per tenant at provisioning — not a `WHERE false` query,
because a query that matches no index entry is measurably *faster* than one that matches one.
Statement 3 is identical in all three cases by construction: **the page renders the tenant's
contact, never the person's anything**, so there is no per-caller branch to leak.

That removes the structural difference. It does not remove noise, and it is not meant to.

### Part 2 — release on a fixed schedule, not when ready

Node cannot be made constant-time; garbage collection, JIT and event-loop delay all vary. What
*can* be made input-independent is **when the response is written**.

```ts
const RELEASE_GRID_MS = 250;               // one parameter, measured, not guessed
const t0 = performance.now();
const page = await buildClosedWindowResponse(identifier);   // the four statements
const elapsed = performance.now() - t0;
const slot = Math.ceil((elapsed + 1) / RELEASE_GRID_MS) * RELEASE_GRID_MS;
await sleepUntil(t0 + slot);
return page;
```

Two properties that matter, and one that is a compromise:

- The release instant is a multiple of 250ms from request entry, **regardless of what the work
  found**. An observer measuring wall-clock sees the grid, not the query.
- Work that overruns lands in the next slot rather than being released immediately — otherwise
  the overrun is itself the signal.
- **The compromise:** a request that overruns 250ms *does* land one slot later, which is a
  one-bit signal in pathological cases. It is mitigated by choosing the grid well above the
  p99.9 of the work (250ms against a budget of ~15ms of database time), and by **alerting on
  every overflow** — an overflow is both an operations problem and a security one, and it should
  page somebody rather than quietly widen the channel.

`RELEASE_GRID_MS` is a parameter, and the Test agent replaces my 250 with a number measured on
the deployed environment, exactly as the BA asked for the 5ms threshold.

### Part 3 — the other channels, one by one

| Channel | What leaks if ignored | Design |
|---|---|---|
| **Response bytes** | A body naming the person, or a different length | The body depends only on the tenant. Rendered from `closedwindow.*` strings and the tenant's DPO contact — **the same bytes for every caller at that tenant** |
| **CSP nonce** | A per-response random nonce makes "byte-identical" literally impossible | **Hash-based CSP on this page, not nonce-based.** There is no per-response randomness on the closed-window page at all. This is why the requirement is satisfiable as literally written |
| **Set-Cookie** | Issuing a session cookie only for a real person is a perfect oracle | **No cookie is set on this path, in any case.** Not "the same cookie" — none |
| **Redirects** | A found account redirecting to an IdP, a stranger not | The closed-window page is a terminal 200. No redirect in any case |
| **Rate limiter** | A counter keyed on a resolved person, or a different threshold | Keyed on `(tenant, client IP, SHA-256 of the submitted identifier)`. Incremented **before** statement 1, so the increment cannot depend on the result. One threshold for everyone. The 429 is released on the same grid |
| **Email** | The classic one: a magic link sent only if the account exists | The send is **enqueued to pg-boss after the response is released**, never awaited on the request path. The HTTP response is identical; an attacker who does not control the mailbox observes nothing. An attacker who *does* control it is reading their own mail |
| **Analytics** | `closed_window_dpo_contact_opened` carrying `days_since_exit` would defeat all of the above through the events table | Payload is `{}`, per the requirements. I would add: it is emitted in **all three cases**, so its presence is not a signal either |
| **Audit** | — | Written in all three cases, and asymmetric on purpose. The BA is right: the invariant is about what the *caller* observes. HR is entitled to know an unknown address tried to sign in |

### Part 4 — what I cannot fully close, stated rather than buried

1. **Node is not a constant-time environment.** The grid masks work-dependent variation; it does
   not make the process deterministic. GC and event-loop noise remain — but they are *not
   correlated with the input*, so they add noise to an attacker's measurement rather than signal.
   That is the right direction, and it is the honest limit of the technique.
2. **Database cache effects** — a hot row versus a cold one — are masked only while the grid
   exceeds the slowest case. Under heavy load that assumption weakens, which is the overflow
   alert's real job.
3. **Traffic analysis at scale.** An attacker who can measure aggregate load, or who can get the
   server into overflow deliberately, has a channel this design does not close.
4. **Everything in front of Node** — TLS termination, CDN, WAF — has its own timing behaviour.
   **The test must measure at the edge the attacker reaches, not against the Node process**, or
   it proves something about the wrong system.
5. **The sign-in address itself.** The BA's assumption 12 is that the closed-window page is
   reached at a tenant-specific address, which is what makes rendering that tenant's DPO contact
   safe. That is correct — and it means **the address space enumerates customers**: if
   `northwind.thrive.app` answers and `notacustomer.thrive.app` does not, you can test whether a
   company is a customer. That is a different and much lower-severity leak than employment
   history, but it is real, it is not in the requirements, and it should be a deliberate decision
   rather than a side effect. → **Q-19.**

**If the human decides sign-in must be one shared address**, this design does not survive and
the requirement needs re-deriving — the page could then not name any contact without answering
"which employer", which is exactly what the BA flagged. Saying so now, as the handoff asked.

---

## The access log — schema, and the derivation that must not lie

The BA found the three real gaps: no purpose, no actor name, and a `NULL` actor that means two
different things. The third is the dangerous one. *"No person read your record"* is the most
damaging false sentence this screen can produce, and today's schema would produce it.

### The columns, and why each one is shaped the way it is

Added to `audit_log` in migration 0003:

| Column | Type | Null? | The decision |
|---|---|---|---|
| `actor_kind` | enum `human` \| `system` | **NOT NULL, no default** | No default **on purpose**. A default lets a future writer omit it and silently get a value. Every writer must state it. Existing rows are backfilled explicitly to `human` in the migration, because everything that has ever written to this table was a person acting |
| `actor_display_name` | text ≤200 | NOT NULL when `human` | Captured **at write time**, never joined at read time. A join at read time returns today's name, or nothing at all once the person is erased |
| `actor_role_label` | text ≤100 | NOT NULL when `human` | The role held **on the day of the read**. "HR Business Partner", not whatever Meera is now |
| `service_name` | text ≤100 | NOT NULL when `system` | From a closed list of our own jobs |
| `purpose_code` | enum, 7 values | nullable | Nullable is deliberate — RULE-004's fallback path exists precisely because a future path will forget. But see the compile-time guard below |
| `subject_person_id` | uuid | see below | The person the read was **about**. Without it, "everything about Aisha" is a four-way union that the next module falls out of |

Two constraints carry the invariants that comments cannot:

```sql
ALTER TABLE audit_log ADD CONSTRAINT audit_actor_shape CHECK (
  (actor_kind = 'human'  AND actor_display_name IS NOT NULL) OR
  (actor_kind = 'system' AND service_name       IS NOT NULL));

-- The access log renders exactly the sensitive_read rows. Those must be
-- attributable to a subject, or the screen has a hole it cannot see.
ALTER TABLE audit_log ADD CONSTRAINT audit_subject_present CHECK (
  sensitive_read = false OR subject_person_id IS NOT NULL);
```

**Why `subject_person_id` is a CHECK rather than plain `NOT NULL`:** existing rows include writes
(`employment.attribute_changed`, `person.erased`) whose subject is derivable, and I backfill
those. But making the column unconditionally `NOT NULL` would force every future non-subject
audit entry — a setting flip, a failed sign-in from an unknown address — to invent a subject.
Tying the requirement to `sensitive_read` puts it exactly where the access log needs it.

**Backfill of `actor_display_name` for existing rows.** Feature 001's rows have no captured name.
They are backfilled to a sentinel — *"Recorded before names were captured"* — rather than left
NULL. That satisfies the CHECK, and more importantly it renders as an honest sentence instead of
a blank. A blank in an access log reads as a system that lost something.

### Answering the BA's actual question: what does a NULL actor mean now?

It no longer has to mean anything, because **`actor_kind` is recorded at write time and erasure
never touches it.** The derivation, which lives in one function and is the only place these
strings are chosen:

| `actor_kind` | `actor_display_name` | `actor_id` | Rendered as |
|---|---|---|---|
| `system` | — | NULL | System section, collapsed. *"Payroll run — August 2026 cycle. Automatic, no person read your record."* |
| `human` | "Meera Nair" | set | *"Meera Nair, HR Business Partner — opened your record on 14 August 2026. Reason: annual pay review."* |
| `human` | "Former employee" | **NULL** — erased | *"Former employee, HR Business Partner — opened your record on 14 August 2026. Reason: annual pay review."* |
| `human` | sentinel (legacy row) | NULL | `access.unknown_actor`, **still in the human section**, with "Ask about this" |

`actor_id IS NULL` now appears in two rows of that table and decides nothing in either. RULE-005's
rule — *a missing actor is never a system read* — is satisfied structurally rather than by a
convention somebody has to remember.

**Erasure of a viewer** follows feature 001's narrow-grant pattern exactly:
`GRANT UPDATE (actor_display_name) ON audit_log TO hrms_app`, alongside the existing
`GRANT UPDATE (actor_id)`. Two columns, on an otherwise append-only table, for one documented
reason. `actor_kind`, `actor_role_label` and `purpose_code` stay immutable, which is what keeps
the entry readable after the name is gone.

### Purpose: making "somebody forgot" a compile error

The PM's assumption was that a purpose is derivable from the code path. The BA's answer was
*"yes, but a derived purpose reads as a restatement"*, and specified an explicit code. **I can
build the explicit code, and I can do better than hoping people set it.**

The audit writer's signature makes it non-optional:

```ts
export type PurposeCode =
  | 'pay_review' | 'payroll_run' | 'record_correction' | 'onboarding'
  | 'case_handling' | 'employee_request' | 'support';

export async function writeSensitiveRead(
  tx: Tx, actor: Actor,
  e: { subjectPersonId: string; purpose: PurposeCode; /* … */ },
): Promise<void>
```

`purpose` is a required field of a closed union. **A new read path cannot compile without
choosing one** — and the typecheck now actually runs in CI, which it did not before this week.
That converts the BA's assumption 1 from a hope into a build failure. The `NULL` case and
RULE-004's fallback table remain for rows written by paths outside this signature, and for the
legacy rows.

So my answer to the PM's open question: **an explicit purpose code is practical, and the wow
moment does not degrade.** Aisha reads *"Reason: annual pay review"*, not *"Looking at your
details"*.

### Suppression lives in the query, not the template

RULE-010 says a `case_handling` entry is not rendered. My own checklist says suppression belongs
in the query layer, never the UI — a filter in a template is one refactor away from being lost.
So the access-log path does not query `audit_log` at all. It queries a view:

```sql
CREATE VIEW access_log_visible AS
  SELECT id, tenant_id, subject_person_id, at, actor_kind, actor_id,
         actor_display_name, actor_role_label, service_name, purpose_code
    FROM audit_log
   WHERE sensitive_read = true
     AND purpose_code IS DISTINCT FROM 'case_handling';
```

`IS DISTINCT FROM` rather than `<> 'case_handling'`, because `NULL <> 'case_handling'` is `NULL`,
not true — the plain comparison would silently drop every entry with no purpose code, which are
exactly the entries REQ-005 insists must still be shown.

**The ordering trap, which is easy to get backwards:** filter **then** group, never group then
filter. RULE-006 groups by `(actor, purpose, calendar day)` and shows a count when it is more
than one. If a suppressed read were counted and then removed, Meera's *"opened your record 3
times"* would become *"2 times"* on a day she opened it three — and the difference is the leak the
whole panel exists to prevent. Grouping runs over the view, so a suppressed row was never in
scope to be counted.

### The grouped query

```sql
SELECT actor_kind, actor_id, actor_display_name, actor_role_label,
       service_name, purpose_code,
       (at AT TIME ZONE $3)::date AS local_day,
       count(*)                   AS times,
       max(at)                    AS last_at
  FROM access_log_visible
 WHERE tenant_id = current_tenant()
   AND subject_person_id = $1
   AND at >= $2                                     -- RULE-007 window
 GROUP BY 1,2,3,4,5,6,7
 ORDER BY last_at DESC
 LIMIT 26                                           -- 25 + 1 to know if more exist
```

- **Cursor pagination, no total.** `LIMIT 26` tells us whether a next page exists without ever
  computing a count. REQ-019's *"no total is ever computed or displayed"* is satisfied
  structurally, not by remembering not to render it.
- **`AT TIME ZONE $3`** is Aisha's work-calendar zone (RULE-006, RULE-009). A read at 00:03 IST
  belongs to the new day; a DST night still produces one bucket per calendar date because the
  cast is to a date, not a division by 24 hours.
- **The index that makes it bounded:** `audit_log (tenant_id, subject_person_id, at DESC)
  WHERE sensitive_read`. The RULE-007 window bounds the scan; without the window a heavily-audited
  executive at 40,000 entries would be an unbounded read (`SCALE-02`).
- **`access_log_viewed{human_entry_count_bucket}`** is bucketed from the page we fetched — 0, 1-5,
  6-25, 25+ — never from a `COUNT(*)`. The bucket is derivable from ≤26 rows plus the
  next-cursor flag.

**What I am *not* building here:** a materialised rollup of grouped entries. The window bounds the
work; if measurement shows it does not, that is when a rollup earns its place (Gate 0).

---

## PERF-01 — what actually goes to the phone

Target: **interactive under 2.0s on a mid-range Android over 4G**, p95 server under 800ms, and the
per-request setting read adding under 50ms. The honest way to hit that is to send the device very
little and ask it to do almost nothing.

### The budget

| | Budget | How |
|---|---|---|
| Server, p95 | **≤ 400ms** (requirement allows 800) | 4 statements in one transaction, all index-driven |
| HTML, compressed | **≤ 30 KB** | Server-rendered; 25 grouped access entries, not 400 |
| JavaScript, compressed | **≤ 50 KB** | React Server Components; almost nothing is a client component |
| Round trips before first paint | **1** | No client-side data fetch. The page arrives rendered |
| Web fonts | **0** | System font stack. A font file is 100–300 KB and blocks text |
| Images | profile photo only, lazy, explicitly sized | Everything else is text |

### What is server-rendered, and what is not

**Server (React Server Components — no JavaScript shipped for any of this):** current values, the
whole change history, the grouped access log's first page, the confidential panel, the off-state
notice, the DPO contact, every date and duration already formatted, every string already resolved.

**Client (the only interactive pieces):** the self-correction form, "Show more" on the access log,
and the collapse control on the system-reads section.

Two of those three do not need JavaScript at all. The system-reads section is a native
`<details>`/`<summary>`, which gives keyboard support and screen-reader semantics for free and
satisfies REQ-006's "collapsed by default" with zero bytes. The self-correction form is a plain
`<form>` with a server action, so it works before hydration and the 10-second budget in `PERF-02`
does not depend on a bundle having downloaded.

Only "Show more" is genuinely a client component, and it exists mainly to meet `A11Y-02` and
`A11Y-05` — move focus to the first newly-loaded entry, announce the new count through an
`aria-live="polite"` region. A plain link would reload the page and lose focus position.

### The decision that saves the most bytes: format on the server

RULE-009 requires locale-formatted dates and times **in the employee's work-calendar zone**, with
a named zone — *"22 August 2026, 14:32 IST"*. The tempting implementation ships a date library
and a timezone database to the phone. A timezone database is hundreds of kilobytes.

Formatting happens on the server instead, using the platform's built-in `Intl.DateTimeFormat`,
which Node 22 carries with full ICU. The device receives the finished string. This is not only a
performance decision — it is a correctness one, because the server is the only place that knows
Aisha's work calendar, and it means the grouping day (RULE-006) and the displayed day (RULE-009)
are computed from the same source and cannot disagree.

`[VERIFY BEFORE CODING]` that the deployed Node image is built with full ICU rather than
small-icu; a small-icu build silently formats everything as English-US and would ship `I18N-02`
defects that look like a locale bug. This is a Dockerfile assertion and a startup check, not an
assumption.

### 400 access-log entries, and the executive with 40,000

The screen never loads 400. It loads 25 groups, cursor-paginated, bounded by the RULE-007 window
and driven by the partial index above. The **export** is the unbounded one, and it is streamed —
assembled section by section and written to the response as it goes, never built in memory
(`SCALE-02`). Above a parameterised size threshold it becomes asynchronous with a notice
(`PERF-05`).

### The setting read, and why it does not cost 50ms

REQ-016 forbids caching the tenant setting, and the BA explicitly asked me to say so rather than
quietly add a cache. **I am not adding one.** The setting is a `LEFT JOIN LATERAL` inside the
single request-context query shown earlier — it is not a second round trip, so its marginal cost
is an index lookup on `(tenant_id, changed_at DESC)`, well under a millisecond. The 50ms budget
is not under pressure and correctness is not being traded for it.

---

## Migration 0003 — additive, and classified

New file, `packages/db/migrations/0003_record_view.sql`. Never an edit to 0001 or 0002. It adds:

**Columns** on `audit_log`: `actor_kind`, `actor_display_name`, `actor_role_label`,
`service_name`, `purpose_code`, `subject_person_id`, plus the two CHECK constraints and the
backfill described above.

**Column** on `transparency_ledger`: `supersedes_ledger_id` with its unique partial index (Q-13).

**Tables**

| Table | Why |
|---|---|
| `identity_link` | Maps a Keycloak subject to a `person`. Nothing connects a login to an employee today |
| `tenant_record_view_setting` | Append-only history of the flip: `record_view_enabled`, `changed_by`, `changed_by_name`, `changed_at`, `reason` |
| `tenant_dpo_contact` | REQ-013's published contact and response clock |
| `case_suppression` | RULE-014's record. Ships with the columns; see the scope note below |
| `probe_subject` | One sentinel row per tenant, for REQ-031's equal-cost path |
| `export_artefact` | Tracks generated exports so REQ-023 can erase them and the 7-day expiry can be enforced |

**Grants**, following feature 001's narrow-column pattern:

```sql
GRANT UPDATE (actor_display_name) ON audit_log TO hrms_app;   -- erasure only
REVOKE UPDATE, DELETE ON tenant_record_view_setting FROM hrms_app;  -- append-only
REVOKE EXECUTE ON FUNCTION set_config(text,text,boolean) FROM hrms_app;  -- the first lock
```

**Every new personal-data column gets a `data_classification` row in the same migration**, or CI
fails the build — the gate feature 001 already enforces, and which now runs against every
migration in order rather than only 0001, because I fixed that this week. The classifications
come straight from the BA's data specification: `actor_display_name` is `identity`,
`actor_role_label` and `purpose_code` are `employment`, `actor_kind`, `service_name`,
`subject_person_id` are `internal`, each with retention `audit_log_retention_days` and the
`[LAW — VERIFY per market]` marker the BA carried.

**Composite foreign keys with a tenant component on every new reference**, per the rule migration
0002 established: a foreign key without a tenant component bypasses row-level security.

**Reversible.** Every statement is additive — new columns, new tables, new indexes, new
constraints. The down path drops them in reverse dependency order and loses no pre-existing data.
It is written out in the migration file and tested in both directions, as 0002 was.

---

## The tenant setting, and the OpenFeature boundary

The setting lives in Postgres (`tenant_record_view_setting`), read through an interface so the
call sites never change:

```ts
export interface RecordViewGate { isEnabled(tenantId: string): Promise<boolean>; }
```

`docs/06-technology-decisions.md` specifies flags "behind an OpenFeature interface", and the
reason given is call-site stability if a provider is swapped later. I am adopting that boundary
and backing it with a Postgres provider.

**Two honest notes.** First, `@openfeature/server-sdk` is not currently a dependency of this
repo — nothing is, there is no `apps/web`. I will **verify the exact package name, version and
provider interface against the installed package before writing a line of provider code**, and
record what I find. Nothing in this design depends on a particular OpenFeature method name.
Second, feature-flag SDKs normally cache aggressively, and REQ-016 forbids that here. The
provider must resolve per request. If the SDK's provider contract makes a per-request read
awkward, **the interface stays and the SDK goes** — the requirement wins over the stack
preference, and I will say so in the decision log rather than quietly caching.

Resolution is RULE-001 exactly: no row → off; `off` → off; `on` → on; unreadable → off **and an
alert**. One function, one place, and the `NULL → false` mapping happens there and nowhere else.

---

## API surface

Six routes, plus sign-in. Every one carries a `RouteAccess` descriptor.

| Route | Auth | Setting-gated | Post-exit | Success | Failures |
|---|---|---|---|---|---|
| `GET /api/me/record` | employee | ✅ | ✅ *(minimal shape)* | 200 | 401 · 403 `RECORD_VIEW_DISABLED` · 500 on temporal ambiguity |
| `GET /api/me/history` | employee | ✅ | ❌ | 200 | 401 · 403 `RECORD_VIEW_DISABLED` · 403 `POST_EXIT_SESSION` |
| `GET /api/me/access-log` | employee | ✅ | ❌ | 200 | as above · 503 if the audit write fails |
| `PATCH /api/me/details` | employee | ✅ | ❌ | 200 | 403 `FIELD_NOT_SELF_CORRECTABLE` · 422 `UNKNOWN_FIELD` · 409 `STALE_RECORD` · 429 |
| `GET /api/me/export` | employee | **❌ carve-out** | ✅ | 200 stream | 401 · 429 · 503 |
| `GET /api/dpo-contact` | employee | **❌ carve-out** | ✅ | 200 | 401 |
| `PUT /api/admin/record-view-setting` | `hr_admin` | n/a | ❌ | 200 (`unchanged: true` on a no-op) | 403 for `it_admin` · 422 empty reason |

**Error shapes are uniform**: `{ "code": "SCREAMING_SNAKE", "message": "<already localised>",
"field": "<optional>" }`. `UX-04` requires every negative outcome to carry a next step, so the
message is a resolved microcopy string, not an internal one.

**404, not 403, for another person's record** (REQ-001, `SEC-02`): a 403 confirms the record
exists. The handler returns 404 with an empty body — and because these endpoints only ever
address `me`, the case arises only when somebody supplies an explicit id, which the route shape
does not accept in the first place.

**Idempotency** on `PATCH /api/me/details` and the setting flip (`REL-03`): a client-supplied
request key, and for the setting a no-op when the value already matches — one row, one notice, one
event, which is what stops 1,180 people being told twice that a screen they already have was
switched on.

---

## The confidential panel — built so it cannot become conditional

RULE-010's argument is airtight and the implementation is where it gets undone. Three rules, each
enforced by structure rather than by care:

1. **The panel is not passed any data.** The component takes no props derived from the entries —
   no count, no "hasSuppressed", nothing. It renders four resolved strings. A component with no
   input cannot vary with state, and a reviewer can confirm that from the signature alone.
2. **It is rendered by the layout, above the entry list**, not by the list component. It cannot
   be pushed down, reordered by entry count, or lazily loaded, because it is not part of the
   thing that loads.
3. **It is never a `<details>`.** REQ-007 requires the body expanded on first paint; an
   expand control would produce an interaction signal. The optional *"Why is this here?"* link
   opens a longer explanation and emits `hidden_data_explainer_opened` with `{}`.

Per-market string set with a **default fallback**, resolved from the tenant's region. An
unrecognised market resolves to the default set — never to no panel. Fail closed here means
*render the panel*, which is the opposite direction from every other fail-closed rule in this
feature, and that is worth stating out loud because the instinct is to render nothing when a
lookup misses.

The strings ship marked **DRAFTED, NOT LEGALLY APPROVED** and keyed, so counsel's sign-off per
market is a content change and not a code change (Q-02).

**Scope note on RULE-014.** No Cases module exists, so nothing writes `purpose_code =
'case_handling'` today. I am building: the enum value, the query-layer filter, the standing panel,
the `case_suppression` table with the BA's columns, and a constraint that a `case_handling` audit
row cannot exist without a matching suppression record — which alerts rather than silently
hiding. I am **not** building the review queue, the reaffirmation workflow, or the
closure-disclosure decision surface. Those are a workflow with no user yet, and Gate 0's own smell
list names "a workflow engine before the first workflow ships". They belong with the Cases module,
and Q-18 must be settled before that ships, not before this one.

---

## Failure matrix

| What fails | Detected how | Behaviour | What Aisha sees |
|---|---|---|---|
| The audit write fails | Exception inside the read transaction | Whole transaction rolls back. **No employee data is returned** — a read she cannot see in her own log is the promise broken | `retry.later` on a 503, and an alert pages operations |
| The setting store is unreachable | Query error / timeout on the request-context query | **Fail closed: treat as off**, 403, alert | The off-state screen (REQ-012), which is a working screen — export and contact still work |
| The setting row is unreadable or invalid | Resolution returns a non-boolean | Off, and an alert (RULE-001) | Same as above |
| More than one current employment version matches | `employmentAsOf` throws on >1 | 500 and an alert — **never** show one of two possible truths | `retry.later` |
| The notification path is down at a setting flip | Enqueue failure / unsent after 24h | The flip **still succeeds**; the notice queues; alert at 24 hours (`REL-04`) | Nothing at flip time; the notice arrives late |
| The export job dies halfway | Stream error | **No partial file is delivered.** The artefact row is marked failed | `export.failed`, with a retry and the DPO route |
| Export requested 6 times in an hour | Rate limiter | 429, and a repeated-breach alert (`COMP-60`) | `export.ratelimited`, naming when she can retry |
| Keycloak is down | OIDC discovery/token failure | Sign-in fails cleanly; no session issued | `error.401` — not a stack trace, not a redirect loop |
| A closed-window request overruns the release grid | Elapsed > `RELEASE_GRID_MS` | Response released on the **next** grid slot, and an **alert** — an overflow widens the timing channel | Nothing different |
| A `case_handling` row exists with no suppression record | Constraint / reconciliation check | Alert. The entry stays suppressed — it is not revealed by a data defect | Nothing different; the panel was always there |
| The DPO contact is unconfigured | Null on the tenant contact row | `dpo.unconfigured` with the fallback route, and an alert — a blank contact panel is a compliance failure wearing a UI gap | The fallback contact, never a blank panel |
| A route ships with no `access` descriptor | Boot-time manifest check | **The server does not start** | Nothing — it never deployed |

---

## NFR plan

| NFR | Target | How this design meets it | How it is verified |
|---|---|---|---|
| `SEC-01` | Setting + policy checked server-side on every endpoint | One middleware driven by the route manifest; no route self-gates | 6 routes × 6 personas × 3 setting states, enumerated from the manifest |
| `SEC-02` | Another tenant's id → 404, empty body | Routes address `me` only; RLS + composite FKs underneath | Cross-tenant test as feature 001's |
| `SEC-05` | Append-only audit with actor and previous value | `UPDATE`/`DELETE` revoked; two column grants | Grant assertion read from `information_schema` |
| `SEC-07` | Reason and free-text fields escaped | React escapes by default; **no `dangerouslySetInnerHTML` anywhere** — CI grep | A reason containing `<script>` renders as text |
| `SEC-08` | Photo type-checked, size-limited, signed URL | Content-type sniffed from bytes, not from the header; short-lived signed URL; never a public bucket | Upload a renamed executable; expect 422 |
| `SEC-09` | Session bounded; setting re-evaluated per request; post-exit reaches 3 surfaces | Nothing authorisation-relevant in the cookie; window computed per request from `exit_date` | Manifest-enumerated post-exit test |
| `SEC-10` | Export 5/employee/hour | Limiter keyed on employment; 429 + alert | Sixth request returns 429 |
| `PRIV-07` | No PII in events, logs or traces | Redaction at the logger, not the call site (feature 001 pattern); event payloads are names and enums | Sentinel-value test — see *Testing* |
| `PRIV-08` | Suppression not inferable | Panel takes no props; filter before grouping; bucketed event payload | Byte-identical render test, with a positive control |
| `PRIV-08` (2nd) | Closed window indistinguishable | Four locks above | ≥200 samples/fixture at the edge; median Δ under the measured threshold |
| `PRIV-09` | Every new column classified | Rows in the same migration | CI classification gate (now runs all migrations) |
| `PRIV-10` | Every new store erasable | Registered in `CORE_HR_STORES` | Independent per-store assertions with before-counts |
| `PERF-01` | Interactive < 2.0s; p95 < 800ms; setting read < 50ms | Budget table above; setting is a join, not a round trip | Lighthouse on throttled 4G + k6 on the server |
| `PERF-02` | Self-correction < 10s | Plain form + server action; works before hydration | End-to-end timing test |
| `SCALE-02` | Cursor pagination; streamed export; no unbounded query | `LIMIT 26`, no `COUNT(*)`; partial index; streamed assembly | `EXPLAIN` assertion that the access-log plan uses the index and is bounded |
| `REL-03` | Idempotent flip and correction | Request key; no-op detection | Double-tap test asserts one row, one notice, one event |
| `REL-08` | Employee's calendar day, DST and month boundaries | `AT TIME ZONE` cast to date, one source for grouping and display | 23:58/00:03 IST and an EU DST night |
| `REL-09` | Mixed PATCH rejected whole | Allowlist check before any SQL is constructed | Mixed payload: 403 **and** the allowed field unsaved |
| `OBS-01` | Correlation id, tenant, actor on every line, redacted | OpenTelemetry span context; logger redaction | Log-scan test |
| `OBS-03` | All events emitted | First-party `analytics_event` | One assertion per event, including the six that must fire when the setting is off |
| `OBS-04` | Alerts with runbooks | Listed in the failure matrix | Each alert has a runbook link; asserted present |
| `A11Y-02` | Keyboard-complete | Native `<details>`, real `<form>`, focus management on "Show more" | Keyboard-only pass + axe in CI |
| `A11Y-04` | Text labels, not colour alone | The future badge and the human/system split are words | axe + a snapshot assertion |
| `I18N-02` | No ISO date shown to a user | Server-side `Intl` formatting; ISO only in the export | Rendered-output scan **with a positive control** |
| `COST-03` | Audit growth projected | Every record view writes a row; projection before ship | Documented projection, not a guess |

---

## Erasure (REQ-023)

Three new stores register with `erasePerson`, each asserted independently:

| Store | Mode | What happens |
|---|---|---|
| `audit_log.actor_display_name` | minimise | Pseudonymised to "Former employee" where the erased person was the **viewer** — the narrow column grant. `actor_kind` and `actor_role_label` survive, which is what keeps REQ-020's sentence renderable |
| `identity_link` | delete | The Keycloak subject mapping is removed outright. This is also what makes REQ-031's case C take the same path as case B |
| `export_artefact` | delete | Generated files removed, and the 7-day expiry enforced by a job regardless |

`tenant_record_view_setting` is **not** erased: it is a decision about the organisation, not
personal data about Aisha, and `changed_by_name` names the admin who flipped it — that person's
erasure pseudonymises it through the same pattern if they leave.

**The test follows the shape I just had to fix in feature 001:** count what exists **before**
erasure using the identifier the fixture seeded, assert it is greater than zero, erase, then
assert zero — never using the eraser's own predicate as the assertion.

---

## Observability

OpenTelemetry spans per request with tenant, correlation id and actor employment id as attributes,
PII redacted at the logger. Business events go to the first-party `analytics_event` table — no
third-party analytics SDK in the employee app, per the stack decision.

**The alerts, each with a runbook entry:** audit-write failure · setting notice unsent at 24h ·
`access_log_purpose_missing` · unconfigured DPO contact · setting store unreachable · closed-window
release-grid overflow · `case_handling` row without a suppression record · repeated export
rate-limit breach (`COMP-60`).

**The two that will page somebody first**, and therefore need the best runbooks: audit-write
failure (it returns 503 to real employees) and setting-store unreachable (it silently turns the
feature off for a whole tenant, which looks like an outage to Priya and like a policy change to
Aisha).

---

## Designing for testability — how this feature avoids the vacuous-assertion trap

I swept feature 001's suite this week and found **12 provably vacuous assertions** — tests that
verify behaviour using the same predicate, constant or derivation the production code uses, so
they would pass with the behaviour deleted. Three of them were in the erasure test that let a live
`COMP-22` defect ship. This is the third time the pattern has been caught in this product.

The Test Automation agent writes the tests. My job is to design so the honest test is the easy one.

### The rule I am asking for

**An assertion must not use the same predicate, constant or derivation as the code it tests**, and
**every "assert absent / assert zero" needs a positive control** proving the thing could have been
present.

### The independent oracle for each critical assertion

| Assertion | The trap | The independent oracle |
|---|---|---|
| **REQ-007** — panel byte-identical with and without suppressed entries | Comparing two renders that both happen to have nothing suppressed. This passes trivially | Verify the suppressed fixture **through the owner role, bypassing the view**, that it has ≥1 `case_handling` row. Assert that count > 0 *before* comparing renders |
| **REQ-031** — three responses indistinguishable | Fixtures that are not actually in the three intended states; timing measured against Node instead of the edge | Confirm each fixture's state with an owner-role query (A has an `exit_date` > 90 days back; B has no `identity_link`; C has been through `erasePerson`). Measure at the deployed edge. **Then mutate**: re-introduce the naive look-up-and-branch and assert the timing test **fails** |
| **REQ-001** — setting gate on every endpoint | A hand-written list of routes that goes stale — feature 001's `TENANT_SCOPED` bug exactly | Enumerate routes from the **filesystem walk the server itself uses**. A new route appears in the test automatically |
| **REQ-022** — post-exit allowlist | Same failure mode, one release later | Same manifest enumeration; assert **exactly three** have `postExit: true`, so a fourth fails the test rather than passing quietly |
| **Erasure (REQ-023)** | Using the eraser's own `WHERE` clause as the assertion — the defect I just fixed | Assert against the identifier the fixture seeded, with a before-count > 0 guard |
| **`I18N-02`** — no ISO dates rendered | Scanning output that contains no dates at all | Positive control: assert the fixture contains a date that **would** render as `2026-09-01` if unformatted, and that the formatted string is present. Then assert the ISO pattern is absent |
| **`PRIV-07`** — no PII in logs | Feature 001's version searched for a value **no code path could put there** — vacuous by schema | Inject a sentinel phone number that genuinely flows through the request. Assert it appears in the **response body** (proving it reached the system) and is absent from the log output |
| **`SCALE-02`** — no unbounded query | Asserting a row count instead of a plan | Assert on `EXPLAIN` output that the access-log query uses the partial index and has a bounded row estimate |
| **REQ-005 purpose** | Asserting the rendered string equals the string the lookup returns | Assert against the **business fact**: the fixture recorded `purpose_code = 'pay_review'`, so the sentence must contain "annual pay review" — a value written in the fixture, not read from the production lookup |

### The one I would add on top

**A mutation check on the three assertions that matter most** — REQ-007's panel, REQ-031's timing,
and the erasure propagation. Break the behaviour deliberately, confirm the test goes red, restore.
I did exactly this on the feature 001 fix: neutering the `audit_log` eraser turned 4 tests red
where previously it would have turned **none** red. That is the only evidence that separates a
test which checks something from a test which merely runs.

---

## What I am NOT building

**Out by requirement** — directory and org chart · any HR-facing screen · correction requests for
locked fields · the durable tracked request route for ex-employees (feature 003) · change
notifications beyond REQ-015's setting notice · document vault · manager view of a team · erasure
request and consent withdrawal in-product · bulk import · native mobile app · **any AI** (REQ-024:
no model call anywhere in this feature; `COMP-70`–`COMP-79` and `AI-*` do not apply, and CI's
gateway-boundary check confirms it).

**Out by my judgement, and these are the ones to argue with:**

| Not building | Why | When it comes back |
|---|---|---|
| **RULE-014's review queue, reaffirmation workflow and closure-disclosure surface** | A workflow with no user. No Cases module exists, nothing writes `case_handling`. I am shipping the table, the filter, the panel and the pairing constraint — the mechanism — and not the workflow | With the Cases module. Q-18 must be settled first |
| **Per-tenant database roles** | Assessed above. A platform project that changes a one-way door, not a line item in this feature. The three locks close the reachable path now | Named follow-up, owner me, raised to the PM and the human |
| **A cache in front of the tenant setting** | REQ-016 forbids it and the measurement does not need it | If p95 ever demands it — and then it is a decision-log entry, not a quiet commit |
| **A materialised rollup for access-log grouping** | The RULE-007 window bounds the work. Building the rollup first is optimising a query nobody has measured | When a measurement shows the window is not enough |
| **A push channel to blank a page when the setting flips** | RULE-001 accepts the rendered page staying visible until the next request; building a websocket for this is a different size of slice | If the human rejects assumption 8 |
| **Encryption for `national_id_ref`** | See below — it does not exist, and this feature should not be where it gets invented | Q-20, before any field claiming `SEC-04` is rendered |

---

## Alternatives I rejected

**Putting tenant, roles and the setting in the session cookie.** Standard, fast, and it makes
REQ-016 and REQ-022 unimplementable — both say in terms that the value must not come from a
claim. Rejected on the requirement, and it would have been the "obvious" design.

**Reading the access log by joining `audit_log` to `employment` at display time.** It is how you
would write it first. It returns today's name, breaks when the viewer is erased, and would have
quietly turned REQ-020 into a list of blanks. Capturing the name at write time costs one column
and no extra query, because the request already knows who the actor is.

**Deriving purpose from `action` only (RULE-004 option b).** Cheaper, and it degrades the wow
moment to *"Looking at your details"* on every human read. The explicit code costs one required
argument on one function, and the type system makes forgetting it a build failure.

**Filtering `case_handling` in the template.** One refactor from being lost, and invisible in
review. A view means the suppressed rows are not in scope to be counted, which also fixes the
grouping-count leak for free.

**A `superseded_for_display` boolean on the original ledger row (Q-13).** Needs `GRANT UPDATE` on
an append-only table. A pointer carried by the new row needs no grant at all.

**Blocking the `app.tenant_id` hole with a `SECURITY DEFINER` setter alone.** I tested it: plain
`SET` walks around it. It would have looked like a fix and been one only on the path that was
never the threat.

---

## One-way doors touched

1. **Multi-tenancy model** (`CLAUDE.md` §7 #1) — not changed here, but the per-tenant-roles
   follow-up **would** change it. Flagged for the PM and the human, not decided by me.
2. **The public surface itself.** Once a sign-in address is published, its shape is hard to
   change, and REQ-031's design depends on it being tenant-specific (Q-19).
3. **The export's JSON schema** (`schema_version`) — people build against exports. Versioned from
   the first release for that reason.
4. **Capturing actor names into `audit_log`** — this writes identity data into a table with a
   7-year retention. It is the right call (REQ-020 needs it) and it is a deliberate widening of
   what the audit log holds, so it is classified, retained and erasable from day one rather than
   retrofitted.

---

## Migration and rollback

**Forward:** `0003_record_view.sql`, additive only. Then deploy `apps/web`. **The tenant setting
is off by default and no tenant has a row**, so on the day this ships every employee sees the
carve-out screen and nothing else — which is the safest possible first day for a first transport
layer, and is a genuine benefit of the human's default-off decision.

**Rollback, in one paragraph a tired on-call engineer can follow.** The feature's own switch is
the first lever: setting `record_view_enabled = false` for a tenant returns that tenant to the
carve-out screen immediately, with no deploy. If the transport layer itself is the problem, take
`apps/web` out of the load balancer — `packages/core` and the database are unaffected, and
feature 001's domain functions do not depend on it. **Do not roll back migration 0003 to recover
from an application fault**; it is additive, it harms nothing while sitting unused, and reverting
it would drop captured actor names that the audit log is now the only record of. Roll it back only
if the migration itself is faulty, using the down path in the file, and accept that the erasure
guarantee on `actor_display_name` goes with it.

**Tested both directions**, as 0002 was, before it is called done.

---

## Problems I found in the requirements

I do not edit `20-requirements.md`. These are appended as questions to `99-decision-log.md`.
Two of them change what is buildable.

### Q-20 — REQ-002's masked national ID is not buildable, and the reason matters

REQ-002 says national ID is *"shown masked (last 4 characters only)"*. RULE-012 says the column is
*"application-layer encrypted and there is no decryption path in the code today"*. Both cannot be
true: **the last 4 characters of ciphertext are meaningless**, so masking encrypted data shows
Aisha four random characters and calls them her ID.

I checked what is actually there:

```
$ grep -rn "national_id_ref|nationalId" --include=*.ts packages/
  employment.ts:415   const REDACTED_KEYS = new Set(['national_id_ref', …])
  erasure.ts:145      national_id_ref = NULL, …
  (tests only otherwise)

$ grep -rniE "encrypt|decrypt|createCipher|kms|envelope" --include=*.ts packages/*/src
  (no matches)
```

**There is no encryption anywhere in this product.** Migration 0001 line 79 says *"Encrypted at
the application layer before it reaches this column (SEC-04)"* — that comment describes a control
that does not exist, and nothing writes the column, so today it is always `NULL`.

**My recommendation: do not render national ID in this feature at all.** It is always NULL, so the
screen would show an empty row and the export a null field. Rendering a masked value would require
inventing the encryption scheme inside a feature about a read-only screen, and `SEC-04` deserves
its own design — envelope encryption, key rotation, a key-management decision, and a stored
non-secret "last 4" if masking is genuinely wanted. `RULE-012`'s `not_included` section is the
honest place to say the field exists and how to obtain it.

**Blocking:** REQ-002's national-ID line and RULE-012's masking line only. Nothing else waits on it.
Q-11 (does a masked identifier satisfy the right of access) becomes moot until this is settled.

### Q-21 — REQ-014's "same transaction" cannot hold for the streamed export

REQ-014 requires the audit write to happen *"in the same transaction as the read response is
prepared, so a failed audit write means no data is returned."* That is exactly right for the
record view. It is **not implementable for the export**, which RULE-012 requires to be streamed
and, above a threshold, asynchronous — you cannot hold a transaction open across a multi-megabyte
streamed response without pinning a connection for the duration, which is a denial-of-service
waiting to happen on `SEC-10`'s own rate limits.

**Proposed answer, for the BA to confirm:** for the export, **write and commit the audit entry
before the first byte is streamed**. The guarantee REQ-014 wants — no data returned without an
audit entry — is preserved, and strengthened: the entry exists even if the stream then fails. The
`export_artefact` row records the outcome, so a failed export is distinguishable from a successful
one in the audit trail.

**Not blocking** — I can build it this way and the BA can correct me.

### Q-19 — tenant-specific sign-in addresses enumerate customers

Raised in full under REQ-031 above. The BA's assumption 12 is load-bearing and correct, and its
consequence — that the address space tells a stranger whether a company is a customer — is not in
the requirements. Lower severity than employment history, but it should be decided, not inherited.

### Q-22 — REQ-007's "byte-identical including any nonce" needs the CSP decision

REQ-031 asks for responses byte-identical *"including any nonce or token position"*. A
nonce-based Content Security Policy generates fresh randomness per response by design, so the
assertion is unsatisfiable as literally written wherever one is used. **I am resolving it by using
hash-based CSP on the closed-window page and the access log, so there is no per-response
randomness to normalise** — which makes the requirement literally true rather than
true-after-normalisation. Recorded because it constrains the CSP choice for those pages, and a
later engineer switching to nonces would silently break REQ-031.

### Smaller notes, not questions

- **RULE-006 + RULE-010 ordering.** Filter suppressed entries *before* grouping. Grouping first
  makes the count leak the suppression. The requirements imply it; the implementation makes it
  explicit, and the view enforces it.
- **`IS DISTINCT FROM`, not `<>`,** for the `case_handling` filter — `NULL <> 'case_handling'` is
  `NULL`, which would drop exactly the purpose-less entries REQ-005 insists must still be shown.
- **REQ-019's "no total is ever computed" and `access_log_viewed`'s count bucket** look
  contradictory. They are not: the bucket is derivable from the ≤26 rows fetched plus the
  next-cursor flag. The naive `COUNT(*)` implementation would violate `SCALE-02`.
- **Feature 001's `employmentAsKnownAt` returns `rows[0]`** where `employmentAsOf` throws on more
  than one. REQ-002 requires the loud failure. I will fix `employmentAsKnownAt` to match rather
  than let the record view inherit the quiet one.
- **Feature 001's `withTenant` `ROLLBACK` can mask the original error.** REQ-014 needs the real
  error to reach the alert. Fixed as part of this feature's transport work.

---

## Handoff

**To:** hrms-test-automation, after the human reviews this design
**Ready:** design only. **No code written.** The instruction was to stop here, and I have.

**Read first:** REQ-031 and RULE-010 in the requirements, then the *Designing for testability*
section above. Those two requirements are the ones where a plausible test proves nothing.

**The five tests I care most about, and what makes each one honest:**

1. **REQ-031, the three fixtures.** Byte-identical responses **and** timing indistinguishable, for
   a real day-91 leaver, a person who never existed, and an **erased** person. Confirm each
   fixture's state with an owner-role query before trusting it. Measure at the deployed edge, not
   against Node. **Replace my 250ms release grid and the 5ms threshold with numbers you measured,
   and say what you measured.** Then mutate the code to the naive look-up-and-branch and prove the
   test goes red — a timing test that has never failed is decoration.
2. **REQ-007, the panel.** Byte-identical panel region for a person with suppressed entries and a
   person with none — with a guard asserting the suppressed fixture actually has suppressed rows,
   checked through the owner role. Without that guard the test compares two identical empty states
   and passes forever.
3. **REQ-001 and REQ-022, enumerated from the route manifest**, never from a hand-written list.
   Exactly three routes reachable post-exit; every route × persona × three setting states, with
   "unset" behaving identically to "off" in all of them. This is the feature 001 `TENANT_SCOPED`
   lesson, and it is the reason the manifest exists.
4. **REQ-009, the mixed payload.** `{"personal_phone":"…","manager_employment_id":"…"}` returns 403
   **and the phone number is not saved.** Assert the not-saved half by reading the row back — the
   403 alone is not the test.
5. **REQ-023, erasure.** Count before, assert greater than zero, erase, assert zero — against the
   identifier your fixture seeded, never against the eraser's own predicate.

**Assumptions of mine to challenge:**

- That the release grid can be a fixed 250ms without hurting a legitimate ex-employee's experience.
  It adds up to a quarter-second to a sign-in attempt. I think that is invisible; measure it.
- That formatting every date on the server is enough for `I18N-02`. It removes the client-side
  route to an ISO date; it does not remove the server-side one.
- That capturing the actor's name and role costs no extra query because the request already knows
  the actor. True for the paths in this feature; verify it stays true for the payroll job.
- That `pg`'s `queryMode: 'extended'` is the right lock. I verified it on 8.23.0 — **re-verify on
  any `pg` upgrade**, because it is an internal-ish option and the guard depends on it.

**To the reviewer, the three places I would look first if I were you:** whether any route reaches
the database outside the extended-protocol wrapper; whether the confidential panel takes any prop
derived from the entries; and whether the post-exit test enumerates routes or lists them.

**Blocking the build:** nothing. **Blocking parts of it:** Q-20 blocks REQ-002's national-ID line
only. **Blocking release, not build:** Q-02 (counsel on the panel strings, per market), Q-11.
**Needs a human decision before this ships, not after:** the `app.tenant_id` follow-up on
per-tenant roles, and Q-19 on the sign-in address shape.

---

# Slice 3c — the sign-in flow (added 2026-08-28)

**Tier: L, continued.** This is the authentication half of the transport layer.
It touches auth, so it was never eligible for tier S.

## THE HEADLINE, BEFORE ANYTHING ELSE

**None of this has been run against a real Keycloak.** Not once. The whole flow is
tested against a *synthetic issuer* whose signing key, JWKS and discovery document are
ours, in `apps/web/test/support/synthetic-issuer.ts`.

Read "sign-in works" as **"the relying-party logic is correct against a conforming
issuer, and refuses a hostile one."** It is not "sign-in works against our identity
provider." What has NOT been exercised is listed under *What is not verified* below.

That was a deliberate instruction and I agree with it: every attack worth testing here
needs an issuer that will **misbehave on demand**. A real Keycloak will not mint an
`alg: none` token, will not sign with the wrong key, and will not echo last week's
nonce — so the tests that matter most could not be written against it at all.

## What Aisha can do after this ships that she could not before

She can sign in. She goes to `northwind.thrive.app`, is bounced to her employer's
Keycloak, types her password there, comes back, and has a session — **provided somebody
in HR has linked her login to her employee record.** If nobody has, she is refused and
no record is created for her. Signing out ends her session here **and** at Keycloak, so
the next person on a shared phone does not land in her account.

## Requirement IDs covered

REQ-016 (nothing authorisation-relevant in the cookie) · REQ-022 (same, for the exit
window) · REQ-031 (the sign-in address is tenant-specific, and readable per Q-19) ·
`SEC-01` · `SEC-02` · `SEC-09` (partially — the sign-out half; lifetime enforcement is
slice 3d).

## What I kept and what I discarded from the previous session

| Partial file | Decision |
|---|---|
| `src/oidc/pkce.ts` | **Kept unchanged.** S256 hard-coded rather than configurable, three separate one-time values, constant-time comparison, and a `returnTo` allowlist. All correct. It had no tests; it has 15 now |
| `src/oidc/verify.ts` | **Kept unchanged.** `jose` with a relying-party algorithm allowlist, `iss`/`aud`/`exp`, and the nonce checked *before* the signature so a caller that lost the nonce fails loudly. 19 tests now |
| `src/oidc/flow.ts` | **Kept, unchanged.** State checked before the code is exchanged, which is the ordering that matters |
| `src/oidc/config.ts` | **Kept, unchanged.** The discovery document's own `issuer` is compared to the configured one, which stops a redirected or cached document pointing us at somebody else's endpoints |
| `packages/db/migrations/0006_tenant_signin_slug.sql` | **DELETED and rewritten.** See below |
| `apps/web/package.json` + lockfile (`jose ^6.2.10`) | **Kept.** Verified: `jose@6.2.10` is installed, MIT, and every function used (`jwtVerify`, `createLocalJWKSet`, `SignJWT`, `exportJWK`, `generateKeyPair`, `decodeProtectedHeader`) exists in that exact version — checked by running it, not by reading documentation |

The previous session's code was good. What it lacked was a single test and a resolved
Q-19.

## Migration 0006: the opaque slug is gone

The old file gave every tenant a random 32-hex-character address and a CHECK constraint
forbidding anything else. **The human overruled that on 2026-08-28.** Deleted, and
replaced with `0006_tenant_signin_address.sql`:

- `tenant.signin_slug`, **readable**: `northwind`, not `9f2c…`.
- **No database default.** A default would hand every tenant — existing and future — an
  address nobody chose. Provisioning must state one, and the fixture in
  `packages/core/test/setup.ts` was updated because it is provisioning.
- Backfilled from `tenant.name` (`"Northwind Trading Co."` → `northwind-trading-co`),
  with a short id suffix where two customers derive the same label, and a
  `tenant-<id>` fallback for a name that derives to nothing.
- CHECK: a legal DNS label, lowercase only (uppercase is *refused*, not folded — two
  rows differing only in case would be two tenants sharing one address and the UNIQUE
  constraint would not see it), 3–62 characters, plus a reserved-label list so a
  customer called "API" cannot shadow our own address space.
- `tenant_id_for_signin_slug(text)` is kept from the old file — `SECURITY DEFINER`,
  `STABLE`, fixed `search_path`, returning **one uuid and nothing else**. That
  narrowness still matters after Q-19: the ruling accepted the address space is
  enumerable *from outside*; it did not make the customer list readable from inside.

**Tested forward, backward and forward again on postgres:16**, including the collision
path and the re-apply — and unlike the opaque slug, re-running the forward migration
reproduces the *same* address for an unchanged name, which the rollback note now says.

**What the readable address costs, restated so it is not lost:** any company can be
confirmed or denied in bulk, by guessing and — needing nothing from us — through
Certificate Transparency. The decision log records both, and records the two mitigations
offered and not taken (one wildcard certificate; a uniform pre-authentication response).
**Nothing about tenant isolation depends on the address being unguessable.**

## The seven things that had to be right

Each is a place where the broken version and the working version are indistinguishable
from the outside.

### 1. PKCE with S256, never `plain`

`code_challenge_method` is a `const` in `pkce.ts`, typed as a literal. It is not a
parameter, not configuration, not negotiated. There is no `plain` to select.

The test asserts the challenge equals an **independently computed**
`BASE64URL(SHA256(ASCII(verifier)))`, and pins RFC 7636's own worked example.
`expect(challengeFor(v)).toBe(challengeFor(v))` would pass just as happily with a
`plain` implementation on both sides.

### 2. `state` — missing, wrong, and replayed

Missing and wrong are one comparison, in constant time. **Replayed is not**, and this is
the part that is usually got wrong: a replayed callback carries the *correct* `state` by
construction, so no comparison can catch it.

What catches it is that the pending record is **single-use**. It lives in its own sealed,
short-lived cookie (`hrms_signin`), separate from the session — at this point in the flow
nobody has authenticated, and writing these values into the session cookie would mean
issuing a session cookie to an unauthenticated caller. The callback route clears that
cookie on **every** exit — success, refusal, or exception — so a second arrival resolves
`pending` to `null` and is refused as `NO_PENDING_AUTHORIZATION`.

The state check also runs **before the code is exchanged**. A forged callback therefore
never burns a real authorization code, and we never hold tokens an attacker chose for us.
There is a test asserting zero exchanges happened.

### 3. `nonce` validated against the one issued

Checked against the value sealed into the pending cookie. And checked **before** the
signature: a caller that lost the nonce somewhere in the flow would otherwise receive a
token that verifies perfectly, with the replay defence silently absent and nothing to say
it had stopped being there. That path throws `NONCE_NOT_ISSUED`.

### 4. The signature actually verified, with `iss`, `aud` and `exp`

Delegated to `jose`, never hand-rolled. Tested against a token signed by a **different key
carrying the same `kid`**, a token whose payload was edited after signing, a token from a
different issuer, one minted for a different client, and expired tokens on both sides of
the clock tolerance.

### 5. `alg: none` refused, and the wrong key or algorithm refused

The allowlist is `['RS256','ES256']`, frozen, and passed to the verifier by us. **The
relying party decides which algorithms are acceptable, never the token.**

Two tokens are minted by hand in the harness because `jose` will not produce them —
which is a point in its favour and a problem for a test that must prove we refuse them:

- **`alg: none`** — header, payload, empty signature. A verifier that honours the token's
  own `alg` accepts it, and the resulting sign-in looks entirely normal.
- **The algorithm-confusion token** — `alg: HS256`, HMAC-signed with the issuer's own
  **public** key as the shared secret. A verifier that picks the algorithm from the header
  and then looks up "the issuer's key" verifies it successfully, using a key anybody can
  download.

### 6. No auto-provisioning — three independent locks

**Authenticating is not the same as being an employee.** Keycloak can prove somebody
controls an account in the realm. It cannot say they are one of this customer's employees;
that fact lives in `identity_link` and nowhere else.

| # | The lock | What it stops |
|---|---|---|
| 1 | `finishSignIn` denies when the lookup returns `null` | The ordinary case |
| 2 | **`identity_link` has INSERT, UPDATE and DELETE revoked from `hrms_app`** (migration 0005) | Somebody "fixing" lock 1 by creating the missing row. They get a PostgreSQL permission error, not a new employee. UPDATE too: re-pointing an existing link is auto-provisioning wearing a different hat |
| 3 | The lookup runs inside the tenant taken from the request address | A subject linked at another customer resolving to a foreign employee |

Deleting any one of the three still leaves a sign-in that works perfectly for every
legitimate employee. That is exactly why there are three, and lock 2 is asserted against
a real database in `packages/core/test/identity-link.test.ts`.

**"No link", "link disabled" and "linked at another customer" all give the same refusal
with the same code.** Distinguishing them would tell a stranger whether an account exists
at this employer — REQ-031's subject, one step early.

### 7. Sign-out revokes at the identity provider

Built. Sign-out clears our cookie **and** redirects to the issuer's `end_session_endpoint`.

Clearing our cookie alone leaves the Keycloak session alive, so the next visit bounces
through Keycloak, finds a live session, and signs the person straight back in without
asking. On Aisha's own phone that is a mild surprise. On a shared machine in a warehouse
it is not a sign-out at all — it is a redirect, and the next person to use that browser
is her.

**What it does NOT send, and the cost:** `id_token_hint`. We do not keep the ID token,
because the session cookie carries `{ sub, iat, sid }` and nothing else — the property
REQ-016 and REQ-022 rest on — and there is no server-side session store yet. Without the
hint, an issuer typically asks the person to confirm the sign-out rather than performing
it silently. So sign-out still ends the Keycloak session, with one extra tap.
**→ named follow-up, slice 3d: a server-side session record keyed on `sid`, which
SEC-09's lifetime enforcement needs anyway.** Not hidden behind a working-looking redirect.

When the issuer publishes no `end_session_endpoint`, `endSessionUrl` returns `null`, the
local cookie is still cleared, and the caller is told
`identityProviderSessionSurvives: true` so the page can **say so**. A sign-out that
silently does half the job is worse than one that admits it.

## The routes, and the boot check doing its job

Three new routes, each carrying an `access` descriptor:

| Route | auth | settingGated | postExit |
|---|---|---|---|
| `GET /signin/start` | `public` | false | false |
| `GET /signin/callback` | `public` | false | false |
| `POST /signin/out` | `public` | false | false |

`public` is correct and is the only correct answer: these are the routes somebody
reaches when they are **not yet anybody**. They return no employee data and make no
authorisation decision.

**`postExit: false` on all three, deliberately, even though an ex-employee inside the
90-day window must be able to sign in.** The post-exit allowlist governs which routes an
*already established* post-exit session may reach. A `public` route is reachable by
everybody by definition, so declaring `postExit: true` would claim a grant it does not
need and widen a list REQ-022 caps at three. The test asserts the count is still exactly
what it was.

**Sign-out is `public`, and that is a call rather than an oversight.** It has to work for
a session we cannot read — expired, sealed with a rotated key, belonging to somebody
whose link was disabled this morning. Requiring `employee` would mean the people most
likely to need to sign out are the ones who cannot. The cost is that a cross-site request
can force a sign-out: a nuisance, not a disclosure. It is `POST`-only so a bare `<img>`
cannot trigger it, and `SameSite=Lax` withholds the session cookie from a cross-site form
post, so the forced sign-out does not even reach a session.

### The boot check refused to start, and that was the mechanism working

First run after adding the routes:

```
Route manifest check FAILED — refusing to start.
3 route(s) export no `access` descriptor.
  app\signin\callback\route.ts
  app\signin\out\route.ts
  app\signin\start\route.ts
```

All three *did* export a descriptor. They were **unimportable**, and the walk correctly
reports "cannot be checked" and "was not declared" as the same thing — both mean we do
not know who may reach the route.

The cause: `packages/core`'s modules refer to each other with `.js` specifiers that only
a bundler resolves to `.ts`. `src/check-routes.ts` runs under **plain Node with no build
step**, on purpose, because a check that needs a toolchain is a check that gets skipped
in the environment that matters. A static `import { … } from '@hrms/core'` therefore made
the route file unloadable.

Fixed by importing `@hrms/core` **dynamically inside `runtime.ts`**, on the first request
that needs it. Node caches the module, so it costs one resolution. Two properties are
preserved by that shape rather than by care:

1. The boot check still imports every route file with no build step.
2. **`apps/web` still never imports the database driver.** The pool is built by
   `packages/core` (`createAppPool`), so the transport layer has no way to open a
   connection outside the wrapper that forces the extended query protocol — LOCK 2 of the
   four tenant-identity locks in `docs/99-decision-log.md`. `resolveTenantIdForSigninSlug`
   is written the same way: it hands back a **uuid, never a `Tx`**, so there is no
   transaction-with-no-tenant for anybody to hold.

After the fix:

```
Route manifest OK — 4 route(s) checked:
  /api/health                  auth=public settingGated=false postExit=false
  /signin/callback             auth=public settingGated=false postExit=false
  /signin/out                  auth=public settingGated=false postExit=false
  /signin/start                auth=public settingGated=false postExit=false
```

## One refactor, stated because it touched committed code

`sealSession`/`unsealSession` and the new pending cookie both need AES-256-GCM sealing.
The one thing you must never do with cryptographic code is write it twice — the second
copy is where the nonce gets reused or the tag gets dropped. So the primitive moved to
`apps/web/src/sealed.ts` and `session.ts` now calls it, keeping its explicit
three-field pick on the way in and out. Byte layout unchanged, so the existing
session tests — which decrypt a cookie *without* going through `unsealSession`, as an
independent oracle — still pass untouched.

## Failure matrix — the sign-in rows

| What fails | Detected how | Behaviour | What Aisha sees |
|---|---|---|---|
| Keycloak discovery or token endpoint down | Fetch throws / non-2xx | Propagates as itself, **not** as a sign-in refusal. Dressing an outage as "your sign-in was rejected" sends her to reset a password that was never wrong | The generic error page; operations gets the real error |
| ID token fails any check | `IdTokenError` → `SignInError` | 302 to `/signin/failed`, pending cookie cleared | One message. Which check failed is for the log, never the caller |
| Authenticated, but no `identity_link` | Lookup returns `null` | `NOT_LINKED`, **identical response** to a bad token | The same page as any other refusal |
| Callback replayed | Pending cookie already cleared | `NO_PENDING_AUTHORIZATION` | Same page. Start again |
| Sign-in took too long | `now - createdAt > TTL` | `AUTHORIZATION_EXPIRED` | Same page. Start again |
| Unknown sign-in address | `tenant_id_for_signin_slug` → null | **404, empty body**, no hint that other addresses exist | Nothing |
| Issuer publishes no `end_session_endpoint` | `endSessionUrl` → null | Local cookie cleared; `?idp=alive` so the page can say the Keycloak session survives | Told plainly, not a fake clean sign-out |
| Discovery down at sign-out | Caught | Local cookie cleared **anyway** — nobody is trapped signed in | Told the Keycloak session survives |

## What is NOT verified, for want of a real Keycloak

Everything in this list is wiring, and every item is a way for sign-in to fail in
production while all 237 tests stay green:

1. **Keycloak's discovery document.** Field names, whether `end_session_endpoint` is
   published on the realm as configured, whether the `issuer` inside it matches the
   configured one exactly (trailing slash included — `config.ts` compares them and will
   refuse a mismatch, which is right, and is also a plausible first-day failure).
2. **Client configuration.** Whether the redirect URI is registered exactly, whether the
   client is confidential, whether client-secret-basic is the accepted auth method.
3. **The token endpoint's error bodies.** `httpTransport` turns any non-2xx into a
   generic `Token exchange failed: <status>`. Keycloak's `error`/`error_description` JSON
   is not parsed, so a misconfiguration will be diagnosable only from its status code.
4. **Whether Keycloak signs with RS256 in this realm**, and whether its `kid` values
   rotate in a way the (currently uncached) JWKS fetch handles sensibly.
5. **JWKS caching and key rotation.** `jwks()` re-fetches on every callback. That is
   correct-but-wasteful now and becomes a rate-limit problem later.
6. **`prompt`, `max_age`, `acr_values`, `login_hint`** — none sent. Fine for a first
   slice; `max_age` becomes relevant with SEC-09's lifetime work.
7. **The `Host` header behind a proxy.** `signinSlugFromHost` reads `Host`. Behind a load
   balancer that rewrites it, or one that forwards `X-Forwarded-Host`, this resolves the
   wrong tenant or none. **A trusted-proxy decision is required before deployment.**
8. **TLS, certificates, and the wildcard-versus-per-tenant certificate choice** the Q-19
   entry recommends.

## What I did NOT build in this slice

Out of scope by instruction, and listed so nobody assumes otherwise: session lifetime
enforcement (`SEC-09`'s 12-hour/30-minute bounds) · the six record endpoints · the
current-values and history read models · self-correction · the export · post-exit routing
and the middleware that applies the route descriptors · REQ-031's timing defence and the
release grid · any panel rendering · the `/signin/failed` and `/signin/signed-out` pages
themselves (the routes redirect to them; the pages are slice 3d, with the BA's microcopy).

Also not built, and these are my own judgement calls:

| Not built | Why | When |
|---|---|---|
| An audit entry for a refused sign-in | The audit writer requires an `Actor`, and a refused sign-in has none by definition. Forcing one would mean inventing a principal, which is how `actor_id` went wrong in feature 001 | Slice 3d, with the anonymous-actor shape REQ-031 needs anyway |
| A server-side session record | Needed for `SEC-09` lifetime enforcement *and* for `id_token_hint` at sign-out. Both are one piece of work | Slice 3d |
| JWKS caching | Correctness first. Caching a key set is where rotation bugs live, and it needs a rotation story | When a measurement or a rate limit asks |
| Parsing Keycloak's token-endpoint error bodies | Cannot be written honestly without a real Keycloak to see the shapes | With the Keycloak wiring |

## Handoff to hrms-test-automation

**Ready:** slice 3c code and tests. Suite green at **237** (17 ai, 121 core, 99 web),
up from 145.

**The three assertions I would attack first if I were you:**

1. **The synthetic issuer is mine, and that is a conflict of interest.** If it is wrong in
   the same direction as the production code, both agree and prove nothing. The strongest
   independent check available without a container is a **captured real Keycloak ID token
   and JWKS as a fixture** — verify against them offline.
2. **The `NOT_LINKED` refusal must be indistinguishable from a bad-token refusal at the
   HTTP layer**, not only in the code path. I assert the code and the message; I do
   **not** assert that the two responses are byte-identical or identically timed. That is
   REQ-031's shape arriving early, and it is not built.
3. **Re-run my three mutations** — they are reproduced below with exact edits. A test that
   has never been seen to fail is decoration.

**Assumptions of mine to challenge:**

- That the pending cookie's 600-second `Max-Age` is long enough for a real Keycloak
  sign-in including a password reset or an MFA prompt. I think it is; measure it.
- That `SameSite=Lax` survives the return from Keycloak on every browser we support. It
  should — it is a top-level navigation — but it is exactly the assumption that produces
  "sign-in works for everybody except Safari".
- That reading `Host` is safe. It is not, behind an untrusted proxy. See item 7 above.

## Evidence

### Baseline, before this slice

```
packages/ai   Test Files  1 passed (1)    Tests  17 passed (17)
packages/core Test Files  8 passed (8)    Tests 108 passed (108)
apps/web      Test Files  2 passed (2)    Tests  20 passed (20)
```

### After this slice — `pnpm -r test`

```
packages/ai   Test Files  1 passed (1)    Tests  17 passed (17)
packages/core Test Files  9 passed (9)    Tests 121 passed (121)
apps/web      Test Files  7 passed (7)    Tests  99 passed (99)
```

**237 passing, up from 145.** Each package's `test` script runs `tsc --noEmit` first, so
the typecheck is inside those numbers.

### Migration 0006, forward and back on postgres:16

```
$ psql -d m6 -f 0006_tenant_signin_address.sql
ALTER TABLE / UPDATE 4 / ALTER TABLE x4 / CREATE FUNCTION / REVOKE / GRANT

         name          |     signin_slug
-----------------------+----------------------
 !!!                   | tenant-5d0da7fb          <- name derives to nothing
 ACME!!!               | acme
 Acme Ltd              | acme-ltd
 Northwind Trading Co. | northwind-trading-co

-- collision path, three tenants whose names derive to the same label
   name    |   signin_slug
-----------+-----------------
 Acme Ltd  | acme-ltd
 Acme  Ltd | acme-ltd-96c6c2
 acme-ltd  | acme-ltd-fcf50a

-- resolver: exact | case-folded and space-padded | unknown
ecb1b7a6-381a-4feb-85c7-50393b544796 | ecb1b7a6-...-50393b544796 | NULL

-- constraints
Northwind        ERROR:  violates check constraint "tenant_signin_slug_is_a_label"
api              ERROR:  violates check constraint "tenant_signin_slug_not_reserved"
-lead            ERROR:  violates check constraint "tenant_signin_slug_is_a_label"
ab               ERROR:  violates check constraint "tenant_signin_slug_is_a_label"
has_underscore   ERROR:  violates check constraint "tenant_signin_slug_is_a_label"

-- DOWN, then FORWARD again
columns named signin_slug after the down path: 0
after re-applying: identical values to the first run
```

### Verifying `jose` rather than trusting it

Every function used was checked against **the installed 6.2.10**, by running it:

```
jwtVerify function        createLocalJWKSet function   SignJWT function
exportJWK function        generateKeyPair function     decodeProtectedHeader function
license: MIT

verified sub s nonce n1
alg none refused: ERR_JOSE_ALG_NOT_ALLOWED
```

---

## Mutation testing — three broken versions that still look correct

I chose the three where a broken implementation is invisible: it signs people in, the
screens work, and no log line says anything is wrong.

### Mutation 1 — signature verification made to always pass

`apps/web/src/oidc/verify.ts`, replacing the `jwtVerify` call with a decode:

```ts
    // MUTATION 1 — signature verification made to always pass.
    payload = JSON.parse(
      Buffer.from(opts.idToken.split('.')[1] ?? '', 'base64url').toString(),
    ) as JWTPayload;
```

**RED — 10 tests fail:**

```
× the signature is actually checked > refuses a token signed with a key the issuer does not publish
× the signature is actually checked > refuses a token whose payload was edited after signing
× the signature is actually checked > refuses a token with an empty signature
× the algorithm is ours to choose > refuses `alg: none`
× the algorithm is ours to choose > refuses an algorithm outside the allowlist, even a strong one
× the algorithm is ours to choose > refuses the algorithm-confusion token — HMAC signed with the public key
× issuer, audience and expiry > refuses a token from a different issuer
× issuer, audience and expiry > refuses a token minted for a different application
× issuer, audience and expiry > refuses an expired token
× issuer, audience and expiry > refuses a token that expired just outside the clock tolerance
 Test Files  1 failed | 6 passed (7)
      Tests 10 failed | 89 passed (99)
```

**GREEN after restoring:**

```
 Test Files  7 passed (7)
      Tests 99 passed (99)
```

Worth noting what this mutation does NOT break: the happy path. A correctly signed
token still signs Aisha in, the nonce still matches, the subject is still right. The
only difference is that **anybody could now mint a token for anybody**.

### Mutation 2 — `state` checking removed

`apps/web/src/oidc/flow.ts`, step 4 deleted:

```ts
  // MUTATION 2 — the state check removed. The flow still works perfectly.
  void matchesOneTimeValue;
```

**RED — 5 tests fail:**

```
× state > refuses a callback with NO state
× state > refuses a callback with the WRONG state
× state > refuses a state that is the right length but the wrong value
× state > exchanges NOTHING when state fails — the check comes first
× an authenticated subject with no identity link is DENIED > never consults the lookup when the token itself is bad
 Test Files  2 failed | 5 passed (7)
      Tests  5 failed | 94 passed (99)
```

**GREEN after restoring:**

```
 Test Files  7 passed (7)
      Tests 99 passed (99)
```

The fifth failure is the useful one. It is not a `state` test — it asserts the identity
lookup is never reached on a bad callback. With `state` gone, an attacker-chosen callback
now reaches a database query. That is the ordering property, and it broke as a side
effect, which is what a second, independent assertion is for.

### Mutation 3 — auto-provisioning turned on

Two halves, because the control is two independent locks and each must be shown to hold
on its own.

**3a — the application branch.** `apps/web/src/oidc/signin.ts`:

```ts
  const identity =
    (await deps.lookupIdentity(completed.subject)) ??
    // MUTATION 3 — auto-provisioning. "They authenticated, so let them in."
    { personId: `auto-${completed.subject}`, tenantId: 'auto-provisioned' };
```

**RED — 2 tests fail:**

```
× an authenticated subject with no identity link is DENIED > refuses, with no session cookie and no link created
× an authenticated subject with no identity link is DENIED > gives the same refusal for a disabled link as for no link at all
 Test Files  1 failed | 6 passed (7)
      Tests  2 failed | 97 passed (99)
```

**3b — the database grant.** `packages/db/migrations/0005_identity_link.sql`:

```sql
-- MUTATION 3b — the grant restored: the application can provision links.
GRANT INSERT, UPDATE, DELETE ON identity_link TO hrms_app;
```

**RED — 4 tests fail, against a real postgres:16:**

```
× the application role cannot auto-provision an identity link > refuses INSERT from the application role
× the application role cannot auto-provision an identity link > refuses UPDATE and DELETE from the application role
× the application role cannot auto-provision an identity link > leaves the row untouched after all of that
× resolving a subject inside a tenant > positive control: Aisha resolves at her own employer
 Test Files  1 failed (1)
      Tests  4 failed | 9 passed (13)
```

The fourth is the one I did not predict and am glad of: the earlier tests' INSERT and
UPDATE **succeeded** once the grant was restored, so by the time the positive control ran,
Aisha's link had been re-pointed at Meera. The suite noticed that the data had been
corrupted by a control that stopped holding. A test file where a broken grant only fails
the tests that name it is a test file that has not understood the blast radius.

**GREEN after restoring both halves — full suite:**

```
packages/ai   Test Files  1 passed (1)    Tests  17 passed (17)
packages/core Test Files  9 passed (9)    Tests 121 passed (121)
apps/web      Test Files  7 passed (7)    Tests  99 passed (99)
```

Reverts confirmed in the source, not by memory:

```
$ grep -n "REVOKE INSERT" packages/db/migrations/0005_identity_link.sql
73:REVOKE INSERT, UPDATE, DELETE ON identity_link FROM hrms_app;
$ grep -n "identity === null" apps/web/src/oidc/signin.ts
155:  if (identity === null) {
$ grep -n "STATE_MISMATCH" apps/web/src/oidc/flow.ts
121:    throw new SignInError('STATE_MISMATCH', 'This sign-in did not start in this browser.');
$ grep -n "jwtVerify(opts.idToken" apps/web/src/oidc/verify.ts
93:    ({ payload } = await jwtVerify(opts.idToken, keys, {
```

**I have not signed this off.** That is the reviewer's, and the Keycloak wiring is
unverified by design.

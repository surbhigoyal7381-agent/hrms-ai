# Decision log — platform and one-way doors

**Append only. Corrections append; they never overwrite.**

This is the file `CLAUDE.md` §7 names as where one-way doors get signed off. It did not
exist until the first one needed deciding. Per-feature decisions stay in
`docs/features/<slug>/99-decision-log.md`; this file is for decisions that outlive a
feature — the six one-way doors in §7, and anything else no single feature owns.

**Who may append:** anyone. **What a §7 entry needs before it counts as decided:** the
human's ruling, the PM's position, and the Full-Stack agent's countersign, per §7.

---

### 2026-08-26 — One-way door 1, multi-tenancy: per-tenant roles DEFERRED, three locks now

**Ruling:** the human, 2026-08-26. **Status of the §7 door:** unchanged — shared schema with
`tenant_id` and `FORCE ROW LEVEL SECURITY` stands. This entry does not open it.

**What prompted it.** Feature 002 ships this product's first public endpoints. `withTenant`
sets `app.tenant_id` from an application-supplied value and every row-level security policy
trusts it, so from deploy day an injection defect anywhere escalates to a full cross-tenant
breach. RLS does not help: the attacker satisfies the policy as a different tenant rather
than bypassing it. Feature 001 accepted this knowingly while nothing could reach it.

**The finding that forced the question.** Feature 001's decision log names a `SECURITY DEFINER`
setter as the fix. **It does not work.** Verified twice against postgres:16 — by the
Full-Stack agent, then independently:

```
REVOKE SET ON PARAMETER "app.tenant_id" FROM role
  -> reports REVOKE, creates ZERO pg_parameter_acl rows, role sets it anyway
REVOKE EXECUTE ON FUNCTION set_config FROM role
  -> works: permission denied
SET app.tenant_id = 'attacker-chosen'   -- same role
  -> SET. Succeeds. Plain SET is a utility statement; it walks around the revoked function.
```

A log entry recording a fix that does not work is worse than one recording nothing, because
the next reader stops looking. A correction is appended to feature 001's log — appended,
never edited, so the wrong belief stays visible with the correction beneath it.

**Decision.** Three locks land in feature 002: revoke `set_config`, force the extended query
protocol through one wrapper with a CI check so stacked statements cannot re-point the
tenant, and a write-once-per-transaction setter. `SET ROLE` is the only primitive PostgreSQL
actually enforces here, so **per-tenant roles remain the durable answer — deferred, not
rejected.**

**Why deferred.** The cost is connection topology, not SQL: a shared pool must be a member of
every tenant role, which re-opens the hole, so it means a pool per tenant and connections
growing linearly with customers. That lands on `COST-01` for every tenant — a 40-person
customer carrying an isolation model it never asked for. And the PM's framing of the real
trade, recorded because it is the honest one: the competitor for that engineering time is
**feature 003**, which carries the `COMP-20` right-of-access debt reviewed 2026-11-30. The
choice was not "should our database be more secure."

**Revisit triggers — either one is sufficient:**
1. A customer contractually requiring physical isolation (§7's own stated trigger).
2. **A single parameterless query found reaching the database outside the wrapper.** That is
   the signal that the locks depend on discipline the team does not have, and roles stop
   being optional.

**Sign-off:** human ✅ · PM ✅ (position: not now, recorded in feature 002's log) ·
Full-Stack ⬜ **countersign pending** — required by §7 before feature 002 ships.

---

### 2026-08-26 — Full-Stack countersign on one-way door 1: **AGREED**, with a fourth lock

**hrms-fullstack-engineer, countersigning the entry above.** The §7 door stays shut, per-tenant
roles are deferred not rejected, and the three locks land in feature 002. I agree with the ruling
and with the reasoning, including the PM's framing that the competitor for that engineering time
is feature 003's `COMP-20` debt. I would have made the same call.

**But the three locks as written are not sufficient, and I found the gap while preparing to
countersign rather than after shipping.**

**A `DO` block is a single statement, so the extended-protocol lock does not stop it, and
`EXECUTE 'SET …'` inside PL/pgSQL is a utility statement, so the `set_config` revoke does not stop
it either.** Verified on postgres:16:

```
-- set_config already revoked from the role:
SELECT set_config('app.tenant_id','x',false)
  -> ERROR:  permission denied for function set_config          (lock 1 holding)

-- but this is ONE statement, so the extended protocol permits it:
DO $$ BEGIN EXECUTE 'SET app.tenant_id = ''pwned'''; END $$; SHOW app.tenant_id;
  -> DO
  -> pwned                                                       (both locks walked around)
```

**Lock 4: `REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC`.** Verified to close it without breaking
anything we need:

```
DO $$ BEGIN EXECUTE 'SET app.tenant_id=''pwned3'''; END $$;
  -> ERROR:  permission denied for language plpgsql              (closed)

BEGIN; SELECT begin_tenant_session('aaaaaaaa-…'); SELECT current_setting('app.tenant_id');
  -> aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa                        (our SECURITY DEFINER setter
                                                                  still callable — USAGE on the
                                                                  language is needed to CREATE a
                                                                  function, not to CALL one)
```

Migrations are unaffected: they run as the owner, and 0001's own `DO` blocks keep working.

**Two conditions attached to my countersign. I am building both; if either is dropped, my
countersign does not carry.**

1. **Lock 4 ships with the other three.** Three locks without it is a lock with a documented
   bypass, which is the same failure mode this entry exists to correct — the feature 001 log
   named a mitigation that did not work, and the next reader stopped looking.
2. **Revisit trigger 2 must be detectable by the type system, not only by a CI grep.** The entry
   makes "a single parameterless query reaching the database outside the wrapper" the signal that
   roles stop being optional. A grep over source text cannot see a query assembled at runtime, so
   the trigger would fire late or not at all. `Tx` is currently `pg.PoolClient`, which exposes the
   raw client to every caller in `packages/core`. I am narrowing `Tx` to an interface that does
   not carry the unsafe call at all, so the wrapper is the only reachable path by construction and
   the grep becomes a second line rather than the only one.

**What I am not claiming.** These four locks close the paths I have tested. They do not make the
GUC unforgeable — `SET` is still a legal statement for this role, and any future code path that
reaches the database outside the wrapper re-opens it. That is precisely why per-tenant roles are
recorded as deferred rather than solved, and why trigger 2 matters more than trigger 1: trigger 1
is a customer we may never get, trigger 2 is a Tuesday.

**Countersigned. Sign-off is now: human ✅ · PM ✅ · Full-Stack ✅ (conditional on locks 1–4 and
the `Tx` narrowing landing together in feature 002).**

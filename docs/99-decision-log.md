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

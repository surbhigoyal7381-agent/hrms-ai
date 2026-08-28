/**
 * Who is this request from — SEC-01, SEC-02, REQ-016, REQ-022.
 *
 * Everything an authorisation decision needs, resolved from the database on
 * EVERY request, from one round trip. Nothing here is carried in a token.
 *
 * That is not caution for its own sake, it is what the requirements say in
 * terms. REQ-016: the setting "is evaluated from the store on every request and
 * is never read from a session claim, a cached flag, or a JWT". REQ-022: the
 * window "is re-evaluated per request against the exit date, never from a claim
 * baked into the token at sign-in". A value that is not in the cookie cannot go
 * stale and cannot be forged, so the cookie carries an identifier and nothing
 * else — see `apps/web/src/session.ts`.
 */
import type { Tx, EmploymentId } from './db.js';
import { asEmploymentId } from './db.js';
import type { SettingSource } from './settings.js';

/** Where the caller sits in the employment lifecycle, computed fresh each call. */
export type Lifecycle =
  /** Hired, not started. REQ-002's edge case: she may still see her own record. */
  | 'pre_hire'
  /** active, on_leave or notice. */
  | 'employed'
  /** exit_date has passed. The post-exit window applies — routing is not built yet. */
  | 'exited'
  /** A person with no employment at all. Cannot act (migration 0002's rule). */
  | 'no_employment';

export interface RequestContext {
  personId: string;
  /** `null` when the person has no employment — they cannot act. */
  employmentId: EmploymentId | null;
  tenantId: string;
  lifecycle: Lifecycle;
  /** Business date, ISO. `null` when no exit is recorded. */
  exitDate: string | null;
  /** RULE-001. Already resolved; `false` when no row exists. */
  recordViewEnabled: boolean;
  settingSource: SettingSource;
}

/**
 * ONE query. Four answers: who, which tenant, is the record view on, and where
 * in the exit lifecycle.
 *
 * `record_view_enabled` arrives as SQL NULL when no setting row exists, which
 * is RULE-001's "unset". It is mapped to `false` on exactly one line below, and
 * that line is the only place in this codebase where the absence of a setting
 * becomes a decision.
 */
const RESOLVE = `
  SELECT p.id                                   AS person_id,
         p.tenant_id                            AS tenant_id,
         e.id                                   AS employment_id,
         e.status::text                         AS status,
         e.exit_date::text                      AS exit_date,
         s.record_view_enabled                  AS record_view_enabled
    FROM identity_link il
    JOIN person p ON p.id = il.person_id
    -- The person's live employment, if they have one. A cancelled employment is
    -- an employment that never happened, so it is not one.
    LEFT JOIN LATERAL (
         SELECT em.id, em.status, em.exit_date
           FROM employment em
          WHERE em.person_id = p.id AND em.status <> 'cancelled'
          ORDER BY em.hire_date DESC
          LIMIT 1) e ON true
    LEFT JOIN LATERAL (
         SELECT trvs.record_view_enabled
           FROM tenant_record_view_setting trvs
          ORDER BY trvs.changed_at DESC, trvs.id DESC
          LIMIT 1) s ON true
   WHERE il.subject = $1
     AND il.disabled_at IS NULL`;

/**
 * Resolves a subject, or resolves to NOTHING.
 *
 * `null` means: no live identity link in this tenant for that subject. It is
 * not an error and it is not an exception, because an exception invites a
 * `catch` that carries on. It is an absence the caller has to handle, and
 * TypeScript will not let it be ignored.
 *
 * Must be called inside `withTenantForResolution`, so row-level security has
 * already scoped it to the tenant taken from the request host. A subject
 * belonging to a different customer resolves to `null` here.
 */
export async function resolveRequestContext(
  tx: Tx,
  subject: string,
): Promise<RequestContext | null> {
  // An empty or whitespace subject would match nothing, but it would also mean
  // the caller has a broken session and does not know it. Say so.
  if (typeof subject !== 'string' || subject.trim().length === 0) return null;

  const r = await tx.query(RESOLVE, [subject]);
  if ((r.rowCount ?? 0) === 0) return null;

  const row = r.rows[0];

  // THE line. No setting row -> off. RULE-001's fail-closed case, mapped in one
  // place, exactly as `settings.ts` does for the direct path. Both go through
  // the same rule; neither invents a default.
  const recordViewEnabled = row.record_view_enabled === true;

  return {
    personId: row.person_id,
    tenantId: row.tenant_id,
    employmentId: row.employment_id ? asEmploymentId(row.employment_id) : null,
    lifecycle: lifecycleOf(row.status, row.exit_date),
    exitDate: row.exit_date ?? null,
    recordViewEnabled,
    settingSource: row.record_view_enabled === null || row.record_view_enabled === undefined
      ? 'unset'
      : 'stored',
  };
}

/**
 * RULE-013 says the window is counted from `exit_date`, "not from the last
 * sign-in and not from the `exited` status transition" — that transition is a
 * job that may run late, and the exit date is the business fact.
 *
 * So this reads the DATE, and treats the status only as a hint. Someone whose
 * exit date has passed is `exited` even if the nightly job has not caught up.
 */
function lifecycleOf(status: string | null, exitDate: string | null): Lifecycle {
  if (!status) return 'no_employment';
  if (exitDate !== null && exitDate <= today()) return 'exited';
  if (status === 'pre_hire') return 'pre_hire';
  return 'employed';
}

/** Business date, UTC. Timezone resolution is not built yet — see the design note. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

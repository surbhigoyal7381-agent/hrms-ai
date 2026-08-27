/**
 * The organisation switch — RULE-001, REQ-001, REQ-012, REQ-016.
 *
 * Whether an employee may open their own record is one setting per
 * organisation, and it is **off until somebody turns it on**. "Off by default"
 * here means something stricter than a default value: a brand-new tenant has no
 * row at all, and no row must behave exactly like `off`.
 *
 * That is the property this module exists to guarantee in ONE place. The
 * mapping from "the database returned nothing" to "the answer is no" happens on
 * a single line. Everywhere else in the codebase asks this module.
 */
import type { Tx } from './db.js';

/** Where the answer came from. Carried so the caller can log and alert honestly. */
export type SettingSource =
  /** No row has ever been written for this tenant. RULE-001's fail-closed case. */
  | 'unset'
  /** A row exists and was read. */
  | 'stored';

export interface RecordViewResolution {
  /** The only field an authorisation decision may look at. */
  enabled: boolean;
  source: SettingSource;
  /** Present only when a row exists — for REQ-015's notice and the export. */
  changedAt: string | null;
  changedByName: string | null;
}

/**
 * The interface the transport layer depends on, so call sites do not change if
 * the store does (`docs/06-technology-decisions.md` — flags behind an
 * OpenFeature interface; the value is call-site stability, not caching).
 *
 * Deliberately NOT cached. REQ-016 says the setting is evaluated from the store
 * on every request and never read from a session claim or a cached flag: Priya
 * switching it off at 11:02 must take effect at 11:03, not whenever a token
 * expires. A cached permission is a permission with a stale answer.
 */
export interface RecordViewGate {
  resolve(tx: Tx): Promise<RecordViewResolution>;
}

/**
 * Reads the newest row for the tenant the transaction is already bound to.
 *
 * No `WHERE tenant_id = ?`. Row-level security scopes this, per the house rule
 * in CLAUDE.md: if application code filtered by tenant, forgetting it once
 * would be the breach; here, forgetting it returns zero rows — which resolves
 * to OFF, which is the safe answer.
 */
export const postgresRecordViewGate: RecordViewGate = {
  async resolve(tx: Tx): Promise<RecordViewResolution> {
    const r = await tx.query(
      `SELECT record_view_enabled,
              changed_at::text AS changed_at,
              changed_by_name
         FROM tenant_record_view_setting
        ORDER BY changed_at DESC, id DESC
        LIMIT 1`,
    );

    // THE line. No row -> off. This is RULE-001's fail-closed case and it is
    // not a default value on a column, because a default is something a future
    // migration can change without anyone reading this comment.
    if ((r.rowCount ?? 0) === 0) {
      return { enabled: false, source: 'unset', changedAt: null, changedByName: null };
    }

    const row = r.rows[0];
    return {
      // `=== true`, not a truthy coercion. The column is boolean NOT NULL, so
      // this is belt and braces — but the cost of being wrong here is a screen
      // opening for a tenant that never asked for it.
      enabled: row.record_view_enabled === true,
      source: 'stored',
      changedAt: row.changed_at ?? null,
      changedByName: row.changed_by_name ?? null,
    };
  },
};

export class RecordViewDisabledError extends Error {
  readonly code = 'RECORD_VIEW_DISABLED';
  readonly status = 403;
  constructor(readonly resolution: RecordViewResolution) {
    super('Your organisation has turned this off.');
    this.name = 'RecordViewDisabledError';
  }
}

/**
 * REQ-001 — the gate every setting-gated endpoint calls BEFORE it reads
 * anything about the employee.
 *
 * Off means 403 from the server. It never means a hidden navigation item: the
 * "My record" entry stays visible and tappable and opens the carve-out screen
 * (REQ-012), because hiding a control is not a permission — it is a suggestion
 * that anyone with developer tools can decline. That is the same rule REQ-009
 * applies to fields, applied to a screen.
 */
export async function requireRecordView(
  tx: Tx,
  gate: RecordViewGate = postgresRecordViewGate,
): Promise<RecordViewResolution> {
  const resolution = await gate.resolve(tx);
  if (!resolution.enabled) throw new RecordViewDisabledError(resolution);
  return resolution;
}

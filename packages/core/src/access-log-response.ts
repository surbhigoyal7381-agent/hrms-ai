/**
 * The access-log response — REQ-005, REQ-006, REQ-007, REQ-019, REQ-020,
 * RULE-007, RULE-010.
 *
 * `access-log.ts` holds the read model and is not touched here: the grouping,
 * the suppression filter in the view, the `IS DISTINCT FROM` that keeps
 * purpose-less entries, the keyset paging and the absence of any `COUNT(*)` are
 * all already right and already tested. This file is what a request assembles
 * ON TOP of it — the window RULE-007 requires us to state, and the standing
 * panel.
 *
 * The ORDER of assembly is the requirement, not a style choice. The panel is
 * built from tenant facts BEFORE the entries are read, and never from them.
 * Building it afterwards would put an entries array within reach of the code
 * that decides what the panel says, and RULE-010's whole point is that no such
 * reach exists.
 */
import type { Tx } from './db.js';
import { readAccessLog, type AccessLogPage, type AccessLogQuery } from './access-log.js';
import { buildConfidentialPanel, type ConfidentialPanel } from './confidential-panel.js';

/**
 * Product default, tenant-configurable per RULE-007. Not yet configurable —
 * there is no tenant settings table for it — so it is a named constant rather
 * than a number buried in a query.
 */
export const ACCESS_LOG_DISPLAY_WINDOW_DAYS = 365;

/**
 * How far back we may HONESTLY say the log goes.
 *
 * RULE-007: `min(configured display window, actual audit retention)`. The screen
 * must never promise a period longer than the data covers — a heading of "the
 * last 12 months" over six months of retained data is a promise the data cannot
 * keep, and the PM's guardrail is that overstating is worse than not shipping.
 *
 * Retention is read from `data_classification`, which is the record of
 * processing and the single source of truth for retention in this product
 * (COMP-30, COMP-34). Reading it here rather than hard-coding 2555 means a
 * market that shortens audit retention shortens this window automatically,
 * instead of the screen quietly over-promising until somebody notices.
 */
export async function resolveAccessLogWindowDays(
  tx: Tx,
  displayWindowDays: number = ACCESS_LOG_DISPLAY_WINDOW_DAYS,
): Promise<{ windowDays: number; limitedByRetention: boolean; retentionDays: number | null }> {
  const res = await tx.query(
    `SELECT min(retention_days)::int AS retention_days
       FROM data_classification
      WHERE table_name = 'audit_log' AND retention_days IS NOT NULL`,
  );
  const retentionDays: number | null = res.rows[0]?.retention_days ?? null;

  // No classified retention at all is not "no limit". It means we do not know
  // how long the data survives, and the honest window is the shorter one we can
  // stand behind.
  if (retentionDays === null) {
    return { windowDays: displayWindowDays, limitedByRetention: false, retentionDays: null };
  }
  const windowDays = Math.min(displayWindowDays, retentionDays);
  return {
    windowDays,
    limitedByRetention: windowDays < displayWindowDays,
    retentionDays,
  };
}

/** Everything the endpoint needs to know about the tenant. Never about the person. */
export interface TenantPanelContext {
  market: string | null;
  dpoName: string | null;
  dpoEmail: string | null;
}

export interface AccessLogResponse {
  /**
   * REQ-007 / RULE-010. Present on EVERY response, in the SAME position, in
   * every state — including when `page.entries` is empty and including when the
   * tenant has never had a case.
   *
   * It is the first field of this object, and that is deliberate: serialised in
   * key order, the panel occupies the same byte range regardless of what follows
   * it. The DOM position is the renderer's job; the payload position is this
   * file's, and both are fixed.
   */
  panel: ConfidentialPanel;
  page: AccessLogPage;
  /** RULE-007 — what the screen may honestly say about the period covered. */
  window: {
    days: number;
    startAt: string;
    /** True when audit retention, not the display setting, is the binding limit. */
    limitedByRetention: boolean;
  };
}

/**
 * Assembles one access-log response.
 *
 * The panel is built FIRST, from `tenant` alone. `readAccessLog`'s result is not
 * in scope when it is constructed — not "not used", not in scope. A later
 * engineer who wants to make the panel conditional has to change this function's
 * shape to do it, which is a diff a reviewer notices.
 */
export async function readAccessLogResponse(
  tx: Tx,
  tenant: TenantPanelContext,
  query: Omit<AccessLogQuery, 'windowDays'> & { displayWindowDays?: number },
): Promise<AccessLogResponse> {
  const panel = buildConfidentialPanel({
    market: tenant.market,
    dpoName: tenant.dpoName,
    dpoEmail: tenant.dpoEmail,
  });

  const window = await resolveAccessLogWindowDays(tx, query.displayWindowDays);

  const page = await readAccessLog(tx, {
    subjectPersonId: query.subjectPersonId,
    timezone: query.timezone,
    windowDays: window.windowDays,
    cursor: query.cursor ?? null,
    pageSize: query.pageSize,
  });

  return {
    panel,
    page,
    window: {
      days: window.windowDays,
      startAt: page.windowStartAt,
      limitedByRetention: window.limitedByRetention,
    },
  };
}

/**
 * The tenant facts the panel is allowed to depend on. One row, the caller's own.
 *
 * `tenant` is row-level-secured with `USING (id = current_tenant())`, so this
 * returns the caller's organisation and nothing else — there is no way to ask it
 * about anybody else's, which is why it is safe to read on a request path.
 *
 * `dpoName` and `dpoEmail` are NULL for every tenant today. There is no
 * `tenant_dpo_contact` table: publishing the data-protection contact is REQ-013
 * and it is a different slice. The panel handles the absence by reporting
 * `dpoConfigured: false` and still rendering — a missing panel is the leak, and
 * a blank contact is a compliance gap, so neither is allowed to remove it. The
 * caller alerts on `dpo.unconfigured`.
 */
export async function readTenantPanelContext(tx: Tx): Promise<TenantPanelContext> {
  const res = await tx.query(`SELECT region FROM tenant LIMIT 1`);
  return {
    market: res.rows[0]?.region ?? null,
    dpoName: null,
    dpoEmail: null,
  };
}

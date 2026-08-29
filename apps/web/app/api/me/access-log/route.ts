import type { RouteAccess } from '@hrms/core';
import { guarded } from '../../../../src/guard.ts';
import { getCore, getPool } from '../../../../src/oidc/runtime.ts';

/**
 * GET /api/me/access-log — REQ-005, REQ-006, REQ-007, REQ-019, REQ-020.
 *
 * The wow moment: who opened Aisha's record, when, and why. And the standing
 * confidential-access panel, which is part of THIS response and not a separate
 * screen — a panel fetched separately could arrive a moment later on some
 * records, and a timing difference is a signal (RULE-010, REQ-031's argument).
 *
 * `tenantSettingGated: true`. Unlike the export, this lives behind the
 * organisation switch: RULE-002 puts the access log in the "gated experience"
 * column, and only the export, the minimal own-fields view and the
 * data-protection contact are carved out as statutory rights.
 *
 * `postExit: false`, narrower than REQ-022 — same as `/api/me/record`, and for
 * the same reason: the 90-day window is not built. REQ-022 excludes the access
 * log from the post-exit allowlist anyway, so this one is not even a divergence.
 */
export const access: RouteAccess = {
  auth: 'employee',
  tenantSettingGated: true,
  postExit: false,
};

export const GET = guarded('/api/me/access-log', async (request, context) => {
  const personId = context.resolved?.context?.personId ?? null;
  const employmentId = context.resolved?.context?.employmentId ?? null;
  const tenantId = context.resolved?.tenantId ?? null;

  if (personId === null || employmentId === null || tenantId === null) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const core = await getCore();
  const cursor = new URL(request.url).searchParams.get('cursor');

  // No work-calendar table exists yet, so RULE-009's "the employee's
  // work-calendar timezone" cannot be resolved. UTC is the honest placeholder
  // and it is wrong for Aisha at 00:03 IST, who will see the previous calendar
  // day. Recorded in the design note rather than left as a surprise.
  const timezone = 'UTC';

  const body = await core.withTenant(
    await getPool(),
    { tenantId, actorEmploymentId: employmentId },
    async (tx) => {
      // Tenant facts only. The panel is built from these and never from the
      // entries — see `readAccessLogResponse`.
      const tenant = await core.readTenantPanelContext(tx);

      const response = await core.readAccessLogResponse(tx, tenant, {
        subjectPersonId: personId,
        timezone,
        cursor,
      });

      // REQ-014: the audit entry is written in the SAME transaction as the read.
      // Reading your own access log is itself a sensitive read, and it appears
      // in your own log next time — which is the correct, slightly recursive
      // answer, and better than an access log with a hole where its own reads
      // should be.
      await core.writeAudit(tx, { tenantId, actorEmploymentId: employmentId }, {
        action: 'access_log.own_view',
        resourceType: 'person',
        resourceId: personId,
        subjectPersonId: personId,
        purpose: 'employee_request',
        sensitiveRead: true,
      });

      return response;
    },
  );

  // Alerts, not response fields. Both are operational problems that must reach
  // somebody, and neither may change a single byte of what Aisha receives.
  if (!body.panel.dpoConfigured) {
    console.error(JSON.stringify({ level: 'error', alert: 'dpo.unconfigured' }));
  }
  for (const entry of body.page.entries) {
    if (entry.purposeMissing) {
      // RULE-004's last resort. The entry is still shown — it is a gap in our
      // recording, not a reason to hide a read from the person it was about.
      console.error(JSON.stringify({
        level: 'error', alert: 'access_log_purpose_missing', action: entry.action,
      }));
    }
  }

  return Response.json(body, { headers: { 'cache-control': 'no-store' } });
});

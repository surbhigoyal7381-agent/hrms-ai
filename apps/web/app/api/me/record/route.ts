import type { RouteAccess } from '@hrms/core';
import { guarded } from '../../../../src/guard.ts';
import { getCore, getPool } from '../../../../src/oidc/runtime.ts';

/**
 * GET /api/me/record — REQ-002, REQ-003, REQ-004.
 *
 * Aisha's own record: what the company currently holds, and every change ever
 * made to it with who decided and why.
 *
 * `tenantSettingGated: true` — this is the experience the organisation chooses
 * about, and it is OFF until somebody turns it on. The switch is applied by the
 * guard, before this module runs; there is no gate check in this file, because
 * a route that gates itself is a route that can forget to.
 *
 * `postExit: false`, and that is NARROWER than REQ-022 grants. The requirement
 * gives an ex-employee 90 days of access to a minimal view of this route, and
 * the window is not built — so every exited session is refused here. Refusing
 * somebody the requirement would admit is a bug to fix; admitting somebody it
 * would refuse is a breach. This is the safe half of that pair, and it is
 * written down rather than left to be discovered.
 *
 * There is no `employmentId` in the path or the query. The route addresses
 * `me` and only `me`, so REQ-001's "another person's record returns 404" is
 * satisfied by a shape that cannot express the question (SEC-02).
 */
export const access: RouteAccess = {
  auth: 'employee',
  tenantSettingGated: true,
  postExit: false,
};

export const GET = guarded('/api/me/record', async (request, context) => {
  const employmentId = context.resolved?.context?.employmentId ?? null;
  const tenantId = context.resolved?.tenantId ?? null;

  if (employmentId === null || tenantId === null) {
    // Authenticated, resolved to a person, but with no employment in this
    // tenant — migration 0002's rule is that such a person cannot act. There is
    // no record to show and nothing to say about anybody else, so: 404, empty.
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }

  const core = await getCore();
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');

  // The business date, resolved once and passed down, so the current values and
  // the "is this change still in the future" flag cannot disagree. Timezone
  // resolution against Aisha's work calendar is not built (there is no work
  // calendar table yet) — this is UTC today, and the design note says so.
  const asOf = new Date().toISOString().slice(0, 10);

  try {
    // `withTenant`, not `withTenantForResolution`: this transaction needs an
    // ACTOR, because REQ-014 requires the audit entry to be written in the same
    // transaction as the response is prepared. One transaction, so a failed
    // audit write rolls the read back and NO employee data is returned — a read
    // Aisha cannot see in her own access log is the promise broken.
    //
    // The pool is the shared one. Building a pool per request would open a new
    // set of connections on every page view and exhaust the server long before
    // anybody noticed the cause.
    const body = await core.withTenant(
      await getPool(),
      { tenantId, actorEmploymentId: employmentId },
      async (tx) => {
        const current = await core.readCurrentValues(tx, employmentId, asOf);
        if (current === null) return null;
        const history = await core.readChangeHistory(tx, employmentId, asOf, cursor);

        // She is reading her own record. `employee_request` is the purpose, and
        // it is a required argument of a closed union — a new read path cannot
        // compile without choosing one, which is what stops "purpose not
        // recorded" spreading (RULE-004).
        await core.writeAudit(tx, { tenantId, actorEmploymentId: employmentId }, {
          action: 'record.own_view',
          resourceType: 'employment',
          resourceId: employmentId,
          subjectPersonId: context.resolved!.context!.personId,
          purpose: 'employee_request',
          sensitiveRead: true,
        });

        return { asOf, current, history };
      },
    );

    if (body === null) {
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    return Response.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof core.TemporalAmbiguityError) {
      // REQ-002: never show one of two possible truths. 500 and an alert.
      console.error(JSON.stringify({ level: 'error', alert: 'temporal_ambiguity' }));
      return Response.json(
        { code: 'TEMPORARILY_UNAVAILABLE' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
    throw err;
  }
});

/**
 * Applying the route descriptors AT REQUEST TIME — REQ-001, REQ-016, REQ-022,
 * SEC-01, SEC-09.
 *
 * `route-access.ts` holds the descriptor type and the BOOT check: every route
 * on disk must declare who may reach it, or the server does not start. That
 * check proves a descriptor EXISTS. It does not make the descriptor do
 * anything.
 *
 * Until this file, nothing did. A route could declare
 * `auth: 'employee', tenantSettingGated: true` and serve the whole internet,
 * and every test in the repository would have stayed green — the descriptor was
 * a comment with a type annotation. This is the half that makes it real.
 *
 * THE DECISION IS A PURE FUNCTION, deliberately. No request object, no
 * database, no framework. That is what lets the test enumerate every route the
 * filesystem walk finds, cross it with every persona and every setting state,
 * and assert the outcome — hundreds of combinations, none of them mocked.
 * Authorisation logic that can only be exercised through an HTTP server is
 * authorisation logic that gets tested on three happy paths.
 *
 * Every branch below denies. There is no `return allow` except the last line,
 * after every gate has been passed.
 */
import type { Lifecycle } from './request-context.js';
import type { Role } from './policy.js';
import type { RouteAccess } from './route-access.js';
import type { SettingSource } from './settings.js';

/**
 * The tenant setting as the transport managed to resolve it.
 *
 * `unreadable` is a THIRD state, not a falsy second one, and keeping it
 * separate is the whole point of this type. Collapsing "the organisation turned
 * it off" and "we could not read our own store" into one boolean is what
 * produces the lie the human ruled against on 2026-08-28.
 */
export type SettingState =
  | { kind: 'resolved'; enabled: boolean; source: SettingSource }
  | { kind: 'unreadable' };

/**
 * Who is asking, as far as the per-request resolution could establish.
 *
 * `null` covers three cases that must be indistinguishable to the caller: no
 * session cookie, a cookie we cannot open, and a valid cookie whose subject has
 * no live identity link. All three mean "we do not know who this is", and all
 * three get the same answer.
 */
export interface AccessPrincipal {
  personId: string;
  tenantId: string;
  lifecycle: Lifecycle;
  /**
   * Resolved per request, never from a token.
   *
   * EMPTY TODAY. Nothing in this product resolves roles from the database yet,
   * so an `hr_admin` route is DENIED rather than waved through. That is a real
   * gap and it fails in the safe direction: the first `hr_admin` route to ship
   * will be refused for everybody, loudly, on its first test — which is a much
   * better failure than the alternative.
   */
  roles: ReadonlySet<Role>;
}

export interface AccessRequest {
  /**
   * The descriptor found for this path at REQUEST time.
   *
   * `undefined` is a real, reachable input. The boot check is the first line of
   * defence, not the only one: a route added to a running process, a manifest
   * that failed to build, a path that resolved to no entry. Whatever the cause,
   * we do not know who may reach it, and the answer to that is never "allow".
   */
  access: RouteAccess | undefined;
  principal: AccessPrincipal | null;
  setting: SettingState;
}

/** Refusal codes. Closed union so a handler cannot invent one. */
export type AccessDenialCode =
  | 'ROUTE_NOT_DECLARED'
  | 'AUTHENTICATION_REQUIRED'
  | 'FORBIDDEN'
  | 'POST_EXIT_SESSION'
  | 'RECORD_VIEW_DISABLED'
  | 'TEMPORARILY_UNAVAILABLE';

export type AccessDecision =
  | { allowed: true; access: RouteAccess }
  | {
      allowed: false;
      status: 401 | 403 | 503;
      code: AccessDenialCode;
      /** Set when the refusal is OUR fault and somebody must be paged. */
      alert: string | null;
    };

const deny = (
  status: 401 | 403 | 503,
  code: AccessDenialCode,
  alert: string | null = null,
): AccessDecision => ({ allowed: false, status, code, alert });

/**
 * The gate. Called on every request, before any handler runs.
 *
 * Ordering is not cosmetic — each step is a precondition of the next, and the
 * cheapest, least informative refusals come first:
 *
 *   1. Do we know who may reach this route at all?
 *   2. Is our own store answering?
 *   3. Do we know who is asking?
 *   4. Do they hold the role the route requires?
 *   5. Have they left?
 *   6. Has the organisation turned this on?
 */
export function decideRouteAccess(request: AccessRequest): AccessDecision {
  const { access, principal, setting } = request;

  // 1. An undeclared route is not "public by default" and not "denied by
  //    default" either — it is a route nobody has decided about. It alerts,
  //    because reaching this line means the boot check was bypassed somehow and
  //    that is an incident, not a 403 to shrug at.
  if (access === undefined) {
    return deny(403, 'ROUTE_NOT_DECLARED', 'route_reached_with_no_access_descriptor');
  }

  // 2. Our store is broken, and that outranks every question about the caller.
  //
  //    The per-request resolution is ONE query: it answers who this is AND what
  //    the organisation's setting says. When it fails, both answers are missing
  //    — so replying 401 "you are not signed in" would be the same class of lie
  //    as the 403 the human ruled against on 2026-08-28, and a worse one,
  //    because Aisha would go and reset a password that was never wrong.
  //
  //    Scoped to routes that actually needed the lookup. A public, ungated
  //    route — the health check, the sign-in redirect — asks the database
  //    nothing, so a broken store is none of its business and it keeps working.
  //    A liveness probe that fails when the database is down reports the wrong
  //    outage.
  if (
    setting.kind === 'unreadable' &&
    (access.auth !== 'public' || access.tenantSettingGated)
  ) {
    return deny(503, 'TEMPORARILY_UNAVAILABLE', 'request_resolution_unreadable');
  }

  // 3. 401, not 403. "You are not signed in" is a statement about the caller;
  //    403 would be a statement about the resource, and we have not looked at
  //    one yet.
  if (access.auth !== 'public' && principal === null) {
    return deny(401, 'AUTHENTICATION_REQUIRED');
  }

  // 4. The role gate. `hr_admin` denies everybody today — see AccessPrincipal.
  if (access.auth === 'hr_admin' && !principal!.roles.has('hr_admin')) {
    return deny(403, 'FORBIDDEN');
  }

  // 5. REQ-022. Checked BEFORE the tenant setting, because the window is
  //    narrower than the switch and never wider: a route an ex-employee may not
  //    reach is one they may not reach in a tenant that has the record view
  //    switched on. Doing the setting first would let a switched-on tenant's
  //    ex-employee through on a route the requirement excludes.
  //
  //    NOTE, and it matters: the 90-day window itself is NOT implemented. This
  //    denies EVERY exited session, including day 1, which is narrower than
  //    REQ-022 grants. Narrower is the safe direction, and it is written down
  //    rather than left for somebody to discover.
  if (principal !== null && principal.lifecycle === 'exited' && !access.postExit) {
    return deny(403, 'POST_EXIT_SESSION');
  }

  // 6. RULE-001, and the human-approved divergence of 2026-08-28.
  if (access.tenantSettingGated) {
    if (setting.kind === 'unreadable') {
      // Step 2 already caught this for every gated route, so reaching here
      // would mean the ordering above had been changed. Kept as a belt: the
      // failure it guards against is answering 403 "your organisation has not
      // turned this on" when the truth is that OUR store is unreachable — a
      // sentence about the employer's choice that is simply false, told on the
      // one screen whose entire purpose is that the company is being straight
      // with her.
      //
      // The safety property RULE-001 exists for is untouched either way: an
      // unreadable setting NEVER grants access. Fail-closed is about ACCESS; it
      // was never a licence to invent an EXPLANATION.
      return deny(503, 'TEMPORARILY_UNAVAILABLE', 'record_view_setting_store_unreadable');
    }
    if (!setting.enabled) {
      // `off` and `unset` are ONE refusal. Not similar — the same status, the
      // same code, and nothing carried out of `setting.source`. An employee who
      // could tell "deliberately off" from "never configured" would be reading
      // an administrative fact about their employer out of an error response.
      // `source` is for the log; it must not reach the wire.
      return deny(403, 'RECORD_VIEW_DISABLED');
    }
  }

  return { allowed: true, access };
}

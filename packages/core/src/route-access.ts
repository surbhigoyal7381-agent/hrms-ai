/**
 * What a route is allowed to be reached by — REQ-001, REQ-022, SEC-01.
 *
 * This file holds the TYPE and the invariants. It deliberately holds NO LIST OF
 * ROUTES. Feature 001 shipped a hand-written list of tenant-scoped tables that
 * omitted the `tenant` table itself and survived 28 passing tests, twice; a
 * hand-written list of routes would be the same artefact with the same failure
 * mode. The content comes from walking the filesystem the server itself serves,
 * so a route that exists is a route that is checked.
 */

/** Who may reach a route at all, before any per-record authorisation. */
export type AuthRequirement =
  /** No session. Sign-in, the closed-window page, health. */
  | 'public'
  /** Any authenticated employee, acting on their own record. */
  | 'employee'
  /** An administrator, checked again by `policy.ts` on the resource. */
  | 'hr_admin';

export interface RouteAccess {
  auth: AuthRequirement;
  /**
   * REQ-001 — is this route behind the organisation switch?
   *
   * `true` for the record view, history, access log and self-correction.
   * `false` for the carve-out: the export, the minimal own-fields view and the
   * data-protection contact are statutory rights, and a tenant setting never
   * governs a statutory right (RULE-002).
   */
  tenantSettingGated: boolean;
  /**
   * REQ-022 — may a post-exit session reach this?
   *
   * Almost always `false`. The window is an ALLOWLIST of three surfaces, not a
   * relaxed employee session, and it is NARROWER than the tenant switch rather
   * than wider. A denylist here decays the first time somebody ships a route
   * and forgets, which is why omission is denial and why `true` is checked
   * against the requirement below.
   */
  postExit: boolean;
}

/**
 * The only paths REQ-022 permits a post-exit session to reach.
 *
 * This IS a hand-written list, and that is correct here, because omission from
 * it means DENIAL. It is the requirement written down — REQ-022 names exactly
 * three surfaces — not an enumeration of the implementation. A route that
 * declares `postExit: true` without appearing here fails the boot.
 */
export const POST_EXIT_ALLOWED_PATHS: readonly string[] = Object.freeze([
  '/api/me/record',
  '/api/me/export',
  '/api/dpo-contact',
]);

/** A route found on disk, with whatever it declared. */
export interface DiscoveredRoute {
  /** URL path the file serves, e.g. `/api/health`. */
  path: string;
  /** Where it came from, so a failure names the file to open. */
  file: string;
  /** `undefined` when the module exported no descriptor — the failure case. */
  access: RouteAccess | undefined;
}

export class RouteManifestError extends Error {
  readonly offending: readonly string[];
  // Written as an explicit field rather than a constructor parameter property,
  // so this module runs under Node's type stripping with no build step. The
  // boot check has to work before anything is compiled — a check that needs a
  // toolchain is a check that gets skipped in the environment that matters.
  constructor(message: string, offending: readonly string[]) {
    super(message);
    this.name = 'RouteManifestError';
    this.offending = offending;
  }
}

function isRouteAccess(value: unknown): value is RouteAccess {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.auth === 'public' || v.auth === 'employee' || v.auth === 'hr_admin') &&
    typeof v.tenantSettingGated === 'boolean' &&
    // Explicitly boolean, not merely falsy. `postExit: undefined` would read as
    // "not reachable" and be right by accident; we want it stated.
    typeof v.postExit === 'boolean'
  );
}

/**
 * Validates the whole manifest, or throws.
 *
 * Called at server start. A failure here stops the process rather than
 * degrading: a route with no descriptor is not "public by default" and is not
 * "denied by default" either — it is a route nobody has decided about, and the
 * safe response to that is to refuse to serve anything at all.
 */
export function assertRouteManifest(routes: readonly DiscoveredRoute[]): void {
  if (routes.length === 0) {
    throw new RouteManifestError(
      'Route manifest is empty. The walk found no routes, which almost always ' +
      'means it was pointed at the wrong directory — and an empty manifest ' +
      'would pass every check below without proving anything.',
      [],
    );
  }

  const undeclared = routes.filter((r) => r.access === undefined).map((r) => r.file);
  if (undeclared.length > 0) {
    throw new RouteManifestError(
      `${undeclared.length} route(s) export no \`access\` descriptor. Every route ` +
      'must state who may reach it, whether the organisation switch gates it, and ' +
      'whether a post-exit session may use it:\n  ' + undeclared.join('\n  '),
      undeclared,
    );
  }

  const malformed = routes
    .filter((r) => !isRouteAccess(r.access))
    .map((r) => r.file);
  if (malformed.length > 0) {
    throw new RouteManifestError(
      `${malformed.length} route(s) export a malformed \`access\` descriptor:\n  ` +
      malformed.join('\n  '),
      malformed,
    );
  }

  // REQ-022. The PM's words: any other route reachable from a post-exit session
  // is a blocker, not a finding.
  const unexpectedPostExit = routes
    .filter((r) => r.access!.postExit && !POST_EXIT_ALLOWED_PATHS.includes(r.path))
    .map((r) => `${r.path} (${r.file})`);
  if (unexpectedPostExit.length > 0) {
    throw new RouteManifestError(
      'Route(s) claim post-exit reachability that REQ-022 does not grant. The ' +
      'window reaches three surfaces and nothing else, and it is narrower than ' +
      'the tenant switch, never wider:\n  ' + unexpectedPostExit.join('\n  '),
      unexpectedPostExit,
    );
  }

  // A post-exit session belongs to somebody who has left, so a route it can
  // reach cannot require a live employee session in the ordinary sense — but it
  // must not be `public` either, or anyone could read it.
  const badPostExitAuth = routes
    .filter((r) => r.access!.postExit && r.access!.auth !== 'employee')
    .map((r) => `${r.path} (auth: ${r.access!.auth})`);
  if (badPostExitAuth.length > 0) {
    throw new RouteManifestError(
      'Post-exit routes must require an authenticated session:\n  ' +
      badPostExitAuth.join('\n  '),
      badPostExitAuth,
    );
  }
}

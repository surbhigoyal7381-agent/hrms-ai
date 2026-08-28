/**
 * The one place a request is let through — REQ-001, REQ-016, REQ-022, SEC-01.
 *
 * NO ROUTE GATES ITSELF. Every handler is wrapped in `guarded()`, which looks
 * the route's descriptor up FROM THE MANIFEST — not from an argument the route
 * passes in, and not from the module the request is heading for. That
 * distinction is the point: a route cannot describe itself as public on the way
 * in and employee-only in its descriptor, because the gate never asks it.
 *
 * The manifest is the same filesystem walk the boot check uses, cached after
 * the first request. So the three artefacts agree by construction:
 *
 *   the walk        finds every route file on disk
 *   the boot check  refuses to start if one declares nothing
 *   this guard      applies what they declared, per request
 *
 * A route with no descriptor cannot start the server. If one somehow reaches
 * here anyway, `decideRouteAccess` denies it.
 */
// TYPES ONLY from the package index. A value import here would make every
// route file that uses this guard unimportable under plain Node, and
// `src/check-routes.ts` runs under plain Node on purpose — a boot check that
// needs a build step is a boot check that gets skipped. The function itself
// comes through `getCore()`, which imports the package lazily.
import type {
  AccessDecision,
  AccessPrincipal,
  RouteAccess,
  SettingState,
} from '@hrms/core';
import { discoverRoutes } from './route-manifest.ts';
import { SESSION_COOKIE_NAME, unsealSession } from './session.ts';
import { loadSealKey } from './sealed.ts';
import {
  UnknownTenantError,
  getCore,
  readCookie,
  requestResolutionForHost,
  type ResolvedRequest,
} from './oidc/runtime.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');

let manifest: Promise<ReadonlyMap<string, RouteAccess>> | null = null;

/**
 * Path -> descriptor, built once from the walk.
 *
 * Cached because the filesystem does not change under a running server, and a
 * directory walk per request would be a real cost on a hot path. NOT cached
 * across a deploy — the process is new, so the map is new. Nothing about
 * authorisation is cached here: the descriptor is a property of the code, and
 * everything that varies per request (who, which tenant, the setting) is
 * resolved per request, which is what REQ-016 requires.
 */
export function routeManifest(): Promise<ReadonlyMap<string, RouteAccess>> {
  if (!manifest) {
    manifest = discoverRoutes(APP_DIR).then((routes) => {
      const map = new Map<string, RouteAccess>();
      for (const route of routes) {
        if (route.access !== undefined) map.set(route.path, route.access);
      }
      return map;
    });
  }
  return manifest;
}

/** Test seam: forget the cached walk. Never called by the server. */
export function resetRouteManifestForTest(): void {
  manifest = null;
}

export interface GuardedContext {
  access: RouteAccess;
  /** `null` on a public route reached without a session. */
  resolved: ResolvedRequest | null;
}

export type GuardedHandler = (
  request: Request,
  context: GuardedContext,
) => Promise<Response> | Response;

/**
 * The error body every refusal shares.
 *
 * One shape, and NOTHING beyond the code. In particular nothing derived from
 * `settingSource`: an employee who could tell "my employer switched this off"
 * from "nobody ever configured it" would be reading an administrative fact
 * about their employer out of an error response (REQ-001).
 */
function refusal(decision: Extract<AccessDecision, { allowed: false }>): Response {
  if (decision.alert !== null) {
    // Structured, and carrying no personal data — the alert names what broke,
    // never who was asking (PRIV-07).
    console.error(JSON.stringify({ level: 'error', alert: decision.alert, code: decision.code }));
  }
  return Response.json(
    { code: decision.code },
    { status: decision.status, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Wraps a route handler in the gate.
 *
 * `pathname` is passed explicitly rather than parsed out of `request.url`
 * because a Next.js route file knows the path it serves and a rewritten or
 * proxied URL does not. Getting this wrong would look up the wrong descriptor,
 * which is the one failure mode that would be silent — so the test asserts the
 * declared path exists in the manifest, and a typo fails there rather than
 * degrading to "no descriptor found" at 3am.
 */
export interface GuardedRoute {
  (request: Request): Promise<Response>;
  /**
   * The path this handler declared, readable at runtime.
   *
   * Not decoration. The test asserts it equals the URL the file actually
   * serves, so a typo — `guarded('/api/me/recrod', ...)` — fails there instead
   * of looking up no descriptor and denying every request in production. A
   * string argument nobody can verify is a string argument that will eventually
   * be wrong.
   */
  readonly declaredPath: string;
}

export function guarded(pathname: string, handler: GuardedHandler): GuardedRoute {
  const wrapped = async function guardedRoute(request: Request): Promise<Response> {
    const access = (await routeManifest()).get(pathname);

    // A route that needs nothing from the database is decided without touching
    // it. Health and the sign-in redirect must keep working during an outage.
    const needsResolution =
      access === undefined || access.auth !== 'public' || access.tenantSettingGated;

    let resolved: ResolvedRequest | null = null;
    let setting: SettingState = { kind: 'resolved', enabled: false, source: 'unset' };
    let principal: AccessPrincipal | null = null;

    if (needsResolution) {
      const sessionCookie = readCookie(request, SESSION_COOKIE_NAME);
      const session = sessionCookie
        ? unsealSession(sessionCookie, loadSealKey('SESSION_COOKIE_KEY'))
        : null;

      try {
        resolved = await requestResolutionForHost(
          request.headers.get('host'),
          session?.sub ?? null,
        );
      } catch (err) {
        if (err instanceof UnknownTenantError) {
          // An address that names no customer. 404 with an empty body, and no
          // hint that other addresses exist.
          return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
        }
        // Anything else is our store failing. `unreadable` — never a 403, and
        // never a 401 either. See decideRouteAccess step 2.
        resolved = null;
        setting = { kind: 'unreadable' };
      }

      if (resolved !== null) {
        setting = resolved.context === null
          ? { kind: 'resolved', enabled: false, source: 'unset' }
          : {
              kind: 'resolved',
              enabled: resolved.context.recordViewEnabled,
              source: resolved.context.settingSource,
            };
        principal = resolved.context === null ? null : {
          personId: resolved.context.personId,
          tenantId: resolved.context.tenantId,
          lifecycle: resolved.context.lifecycle,
          // Empty, always, until role resolution ships. An `hr_admin` route is
          // therefore refused for everybody — loudly, and in the safe direction.
          roles: new Set(),
        };
      }
    }

    const { decideRouteAccess } = await getCore();
    const decision = decideRouteAccess({ access, principal, setting });
    if (!decision.allowed) return refusal(decision);

    return handler(request, { access: decision.access, resolved });
  };

  return Object.defineProperty(wrapped, 'declaredPath', {
    value: pathname,
    enumerable: true,
  }) as GuardedRoute;
}

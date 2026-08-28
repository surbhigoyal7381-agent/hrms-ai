/**
 * Wiring — the part that is NOT covered by the synthetic-issuer tests.
 *
 * Everything else in `src/oidc/` is pure logic over an injected transport, and
 * it is tested hard. This file is where that logic meets a real environment: a
 * connection pool, environment variables, a host name, Keycloak's discovery
 * document. None of it has been run against a real identity provider. Read the
 * design note before assuming "sign-in works" means more than "the flow logic
 * is correct".
 *
 * Everything here is built LAZILY, on the first request that needs it, and
 * never at module import. The boot check in `src/check-routes.ts` imports every
 * route file to read its `access` descriptor; a pool or a config read at import
 * time would make that check need a database and a full environment, and a
 * check that needs those is a check somebody eventually skips.
 */
import type { AppPool } from '@hrms/core';
import { loadSealKey } from '../sealed.ts';
import { httpTransport, loadOidcConfig, type OidcConfig, type OidcTransport } from './config.ts';
import type { LinkedIdentity, SignInDeps } from './signin.ts';

let pool: AppPool | null = null;
let config: OidcConfig | null = null;
let transport: OidcTransport | null = null;

/**
 * `@hrms/core` is imported DYNAMICALLY, and only when a request needs it.
 *
 * Two things depend on that, and both are load-bearing rather than tidy.
 *
 * First, the boot check. `src/check-routes.ts` imports every route file under
 * plain Node — no bundler, no build step — to read its `access` descriptor,
 * because a check that needs a toolchain is a check that gets skipped in the
 * environment that matters. `packages/core`'s modules refer to each other with
 * `.js` specifiers that only a bundler resolves to `.ts`, so a STATIC import of
 * the package index makes a route file unimportable, which the walk reports as
 * "no descriptor" and the boot check turns into a refusal to start. That is the
 * mechanism working correctly on the wrong input.
 *
 * Second, `apps/web` still never imports the database driver. The pool is built
 * by `packages/core`, so the transport layer has no way to open a connection
 * outside the wrapper that forces the extended query protocol — LOCK 2 of the
 * four tenant-identity locks.
 *
 * Node caches the module, so this costs one resolution on the first request.
 */
type Core = typeof import('@hrms/core');
let core: Promise<Core> | null = null;
export function getCore(): Promise<Core> {
  if (!core) core = import('@hrms/core');
  return core;
}

export async function getPool(): Promise<AppPool> {
  if (!pool) {
    const connectionString = process.env.APP_DATABASE_URL;
    if (!connectionString) {
      throw new Error('APP_DATABASE_URL is not set. See .env.example.');
    }
    pool = (await getCore()).createAppPool(connectionString);
  }
  return pool;
}

function getConfig(): OidcConfig {
  if (!config) config = loadOidcConfig();
  return config;
}

function getTransport(): OidcTransport {
  if (!transport) transport = httpTransport(getConfig());
  return transport;
}

/**
 * The tenant label out of the request host — `northwind.thrive.app` -> `northwind`.
 *
 * Readable, per the human's Q-19 ruling of 2026-08-28. The label selects which
 * customer the request is resolved against; it grants nothing, and nothing about
 * tenant isolation depends on it being unguessable.
 *
 * The port is stripped, the host is lower-cased (host names are
 * case-insensitive) and only the first label is taken. A host with no dot —
 * `localhost` — has no tenant label and returns null rather than treating the
 * whole host as one.
 */
export function signinSlugFromHost(host: string | null | undefined): string | null {
  if (typeof host !== 'string' || host.length === 0) return null;
  const withoutPort = host.split(':')[0]!.toLowerCase();
  const labels = withoutPort.split('.');
  if (labels.length < 2) return null;
  const label = labels[0]!;
  // The same shape the database CHECK enforces. Validating here as well means a
  // hostile Host header never reaches a query, even a parameterised one.
  return /^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(label) ? label : null;
}

export class UnknownTenantError extends Error {}

/**
 * Builds the dependencies for one request.
 *
 * The identity lookup it hands over is a READ. There is no write anywhere in
 * this file, and there could not be: `identity_link` has INSERT, UPDATE and
 * DELETE revoked from `hrms_app` (migration 0005), and the connection is that
 * role. Auto-provisioning is not a policy decision here, it is a missing grant.
 */
export async function signInDepsForHost(host: string | null | undefined): Promise<SignInDeps> {
  const slug = signinSlugFromHost(host);
  if (slug === null) {
    throw new UnknownTenantError('This address does not identify an organisation.');
  }
  const { resolveTenantIdForSigninSlug, resolveRequestContext, withTenantForResolution } =
    await getCore();

  const tenantId = await resolveTenantIdForSigninSlug(await getPool(), slug);
  if (tenantId === null) {
    throw new UnknownTenantError('This address does not identify an organisation.');
  }

  return {
    transport: getTransport(),
    config: getConfig(),
    sealKey: loadSealKey('SESSION_COOKIE_KEY'),
    async lookupIdentity(subject: string): Promise<LinkedIdentity | null> {
      // Resolved WITHIN the tenant taken from the address, so a subject linked
      // at another customer resolves to nothing here rather than to a foreign
      // employee. `withTenantForResolution` grants a transaction and NO actor,
      // so nothing requiring one — every audit write — can happen from inside.
      return withTenantForResolution(await getPool(), tenantId, async (tx) => {
        const ctx = await resolveRequestContext(tx, subject);
        return ctx === null ? null : { personId: ctx.personId, tenantId: ctx.tenantId };
      });
    },
  };
}

/** Reads one cookie out of a request's `Cookie` header. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

export interface SerialisableCookie {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
    path: string;
    maxAge?: number;
  };
}

/** Renders a `Set-Cookie` header value. */
export function serialiseCookie(cookie: SerialisableCookie): string {
  const o = cookie.options;
  const parts = [`${cookie.name}=${encodeURIComponent(cookie.value)}`, `Path=${o.path}`];
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite.charAt(0).toUpperCase()}${o.sameSite.slice(1)}`);
  if (typeof o.maxAge === 'number') {
    parts.push(`Max-Age=${o.maxAge}`);
    // `Max-Age` alone is ignored by some older clients, and a sign-out that
    // half-works is worse than one that fails: `Expires` in the past is the
    // belt to `Max-Age=0`'s braces.
    if (o.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

/**
 * Which tenant, and who — the resolution every guarded request performs.
 *
 * ONE round trip does four jobs: who is this, which tenant, is the record view
 * on, and where in the exit lifecycle. That is why nothing authorisation-related
 * is in the session cookie: it costs one indexed lookup we make anyway, and a
 * value that is not in the cookie cannot go stale (REQ-016) and cannot be forged.
 *
 * Throws `UnknownTenantError` for an address that names no customer — which the
 * guard turns into a flat 404. Any OTHER throw is our store failing, and the
 * guard turns that into 503, never 403 and never 401.
 */
export interface ResolvedRequest {
  tenantId: string;
  /** `null` when there is no session, or the subject has no live identity link. */
  context: import('@hrms/core').RequestContext | null;
}

export async function requestResolutionForHost(
  host: string | null | undefined,
  subject: string | null,
): Promise<ResolvedRequest> {
  const slug = signinSlugFromHost(host);
  if (slug === null) {
    throw new UnknownTenantError('This address does not identify an organisation.');
  }
  const { resolveTenantIdForSigninSlug, resolveRequestContext, withTenantForResolution } =
    await getCore();

  const tenantId = await resolveTenantIdForSigninSlug(await getPool(), slug);
  if (tenantId === null) {
    throw new UnknownTenantError('This address does not identify an organisation.');
  }

  // No session: we still resolved the tenant, which is what the setting is read
  // against. The context stays null and the guard refuses anything non-public.
  if (subject === null) return { tenantId, context: null };

  const context = await withTenantForResolution(await getPool(), tenantId, (tx) =>
    resolveRequestContext(tx, subject),
  );
  return { tenantId, context };
}

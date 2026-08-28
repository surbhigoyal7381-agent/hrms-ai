import type { RouteAccess } from '@hrms/core';
import { guarded } from '../../../src/guard.ts';
import { finishSignIn, SignInError } from '../../../src/oidc/signin.ts';
import { PENDING_COOKIE_NAME, clearedPendingCookie } from '../../../src/oidc/pending-cookie.ts';
import {
  UnknownTenantError,
  readCookie,
  serialiseCookie,
  signInDepsForHost,
} from '../../../src/oidc/runtime.ts';

/**
 * The callback — SEC-01.
 *
 * `public`, because the caller has no session yet; that is what this route is
 * for. Everything that decides whether they get one happens inside
 * `finishSignIn`: state, PKCE, signature, issuer, audience, expiry, nonce, and
 * then the identity link.
 */
export const access: RouteAccess = {
  auth: 'public',
  tenantSettingGated: false,
  postExit: false,
};

/**
 * The pending cookie is cleared on EVERY exit from this handler.
 *
 * That is what makes a replayed callback fail. A replay carries the correct
 * `state` by construction — it is a copy of a real one — so comparing `state`
 * cannot catch it. Only the pending record being gone can, and it is gone
 * whether this request succeeded, was refused, or blew up.
 */
const clearPending = () => serialiseCookie({ name: PENDING_COOKIE_NAME, ...clearedPendingCookie() });

/** One shape for every refusal. Which check failed is for the log, not the caller. */
function refused(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      location: '/signin/failed',
      'set-cookie': clearPending(),
      'cache-control': 'no-store',
    },
  });
}

export const GET = guarded('/signin/callback', async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  let deps;
  try {
    deps = await signInDepsForHost(request.headers.get('host'));
  } catch (err) {
    if (err instanceof UnknownTenantError) return new Response(null, { status: 404 });
    throw err;
  }

  const pendingCookie = readCookie(request, PENDING_COOKIE_NAME);

  let done;
  try {
    done = await finishSignIn(deps, pendingCookie, {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
    });
  } catch (err) {
    if (err instanceof SignInError) {
      // Every refusal looks the same to the caller. `NOT_LINKED` in particular
      // must not be distinguishable from a bad state or a bad token: telling a
      // stranger "your token was fine, you are just not an employee here"
      // confirms both that the account exists and that this company is not
      // their employer, which is REQ-031's subject one step early.
      //
      // TODO(slice 3d): structured log line and an audit entry naming the
      // refusal code. Deliberately not written here — the audit writer needs an
      // actor, and this path has none by definition.
      return refused(302);
    }
    // Not an authentication failure — the issuer is down, the database is
    // unreachable. It must reach the alert as itself, not dressed as a refusal.
    throw err;
  }

  const headers = new Headers({ location: done.returnTo, 'cache-control': 'no-store' });
  headers.append('set-cookie', serialiseCookie(done.sessionCookie));
  headers.append('set-cookie', serialiseCookie(done.clearPendingCookie));
  return new Response(null, { status: 302, headers });
});

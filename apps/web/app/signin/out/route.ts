import type { RouteAccess } from '@hrms/core';
import { guarded } from '../../../src/guard.ts';
import { signOut } from '../../../src/oidc/signin.ts';
import { SESSION_COOKIE_NAME } from '../../../src/session.ts';
import {
  UnknownTenantError,
  readCookie,
  serialiseCookie,
  signInDepsForHost,
} from '../../../src/oidc/runtime.ts';

/**
 * Sign out — SEC-09.
 *
 * `public`, and that is a deliberate call rather than an oversight. Sign-out
 * has to work for a session we cannot read: an expired one, one sealed with a
 * rotated key, one belonging to somebody whose link was disabled this morning.
 * Requiring `employee` would mean the people most likely to need to sign out —
 * on a shared machine, with something wrong — are the ones who cannot.
 *
 * The cost of `public` is that a cross-site request can sign somebody out.
 * That is a nuisance, not a disclosure: it returns no data and grants nothing.
 * It is `POST`-only so a bare `<img>` tag cannot trigger it, and `SameSite=Lax`
 * withholds the session cookie from a cross-site form post, so the forced
 * sign-out does not even reach a session. Recorded here rather than in a
 * commit message because the next reader will wonder.
 */
export const access: RouteAccess = {
  auth: 'public',
  tenantSettingGated: false,
  postExit: false,
};

export const POST = guarded('/signin/out', async (request: Request): Promise<Response> => {
  let deps;
  try {
    deps = await signInDepsForHost(request.headers.get('host'));
  } catch (err) {
    if (err instanceof UnknownTenantError) return new Response(null, { status: 404 });
    throw err;
  }

  const origin = new URL(request.url).origin;
  const out = await signOut(
    deps,
    readCookie(request, SESSION_COOKIE_NAME),
    `${origin}/signin/signed-out`,
  );

  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', serialiseCookie(out.clearSessionCookie));
  headers.append('set-cookie', serialiseCookie(out.clearPendingCookie));

  // The redirect is the half that is usually missing. Clearing our cookie alone
  // leaves the Keycloak session alive, so the next visit signs the person
  // straight back in without asking — which on a shared machine is not a
  // sign-out, it is a redirect, and the next user of that browser is them.
  if (out.redirectTo !== null) {
    headers.set('location', out.redirectTo);
    return new Response(null, { status: 302, headers });
  }

  // No `end_session_endpoint` published. The local cookie is gone, and the page
  // must SAY that the identity-provider session survives rather than implying a
  // clean sign-out. `?idp=alive` is what the signed-out page reads to choose its
  // wording; the wording itself is slice 3d's, with the BA.
  headers.set('location', '/signin/signed-out?idp=alive');
  return new Response(null, { status: 302, headers });
});

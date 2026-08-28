import type { RouteAccess } from '@hrms/core';
import { beginSignIn } from '../../../src/oidc/signin.ts';
import {
  UnknownTenantError,
  serialiseCookie,
  signInDepsForHost,
} from '../../../src/oidc/runtime.ts';

/**
 * Start sign-in — REQ-016, SEC-01.
 *
 * `public`, necessarily: this is where somebody who is not yet anybody arrives.
 * It is the only kind of route that may be public — it returns no employee data
 * and makes no authorisation decision.
 *
 * `postExit: false` even though an ex-employee inside the 90-day window must be
 * able to sign in. The post-exit allowlist governs which routes an ALREADY
 * ESTABLISHED post-exit session may reach; a `public` route is reachable by
 * everybody by definition, so marking it `true` would claim a grant it does not
 * need and fail the boot check, which allows exactly three paths (REQ-022).
 */
export const access: RouteAccess = {
  auth: 'public',
  tenantSettingGated: false,
  postExit: false,
};

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('returnTo') ?? '/record';

  let deps;
  try {
    deps = await signInDepsForHost(request.headers.get('host'));
  } catch (err) {
    if (err instanceof UnknownTenantError) {
      // 404 with no body, and no hint that other addresses exist. The Q-19
      // ruling accepted that the address space is enumerable; that is not a
      // reason to help. A uniform pre-authentication response would close the
      // guessing route entirely and is recorded in the decision log as a
      // mitigation available but not taken — taking it later changes REQ-031.
      return new Response(null, { status: 404 });
    }
    throw err;
  }

  const begun = await beginSignIn(deps, returnTo);

  return new Response(null, {
    status: 302,
    headers: {
      location: begun.authorizationUrl,
      'set-cookie': serialiseCookie(begun.pendingCookie),
      // A sign-in redirect must never be cached: a cached one would replay a
      // used `state` and a used PKCE challenge to the next person on the device.
      'cache-control': 'no-store',
    },
  });
}

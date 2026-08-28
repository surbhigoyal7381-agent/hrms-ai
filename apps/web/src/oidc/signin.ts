/**
 * Sign-in, end to end — REQ-016, REQ-022, SEC-01, SEC-09.
 *
 * `flow.ts` knows the OIDC protocol. This file knows OUR RULE, which the
 * protocol has no opinion about:
 *
 *     AUTHENTICATING IS NOT THE SAME AS BEING AN EMPLOYEE.
 *
 * Keycloak will happily prove that somebody controls an account in the realm.
 * It cannot tell us that person is one of this customer's employees, because
 * that fact lives in `identity_link` and nowhere else. So a perfectly valid ID
 * token for a subject with no live `identity_link` row is REFUSED, and no row
 * is created.
 *
 * That refusal is the security control this slice exists to get right, and it
 * is the one that is easiest to undo by accident. The tempting line —
 * "authenticated but unknown, so create the link and let them in" — is how a
 * contractor, an ex-employee whose link was disabled, or anyone who can obtain
 * an account in the identity provider's realm becomes an employee of a customer
 * whose HR team never heard of them. Three independent things stop it:
 *
 *   1. This function denies when the lookup returns null.
 *   2. `identity_link` has INSERT, UPDATE and DELETE revoked from `hrms_app`
 *      (migration 0005), so the request path could not create a link even if
 *      this function tried. Provisioning runs as the owner.
 *   3. The lookup runs inside the tenant taken from the request address, so a
 *      subject linked at ANOTHER customer resolves to nothing here.
 *
 * Deleting any one of the three still leaves a sign-in that works perfectly for
 * every legitimate employee, which is exactly why there are three.
 */
import type { OidcConfig, OidcTransport } from './config.ts';
import { startSignIn, completeSignIn, endSessionUrl, SignInError } from './flow.ts';
import {
  PENDING_COOKIE_NAME,
  clearedPendingCookie,
  pendingCookieOptions,
  sealPending,
  unsealPending,
  type PendingCookieOptions,
} from './pending-cookie.ts';
import {
  SESSION_COOKIE_NAME,
  newSession,
  sealSession,
  sessionCookieOptions,
  unsealSession,
  type CookieOptions,
  type SessionPayload,
} from '../session.ts';

/**
 * What the database says about an authenticated subject.
 *
 * Deliberately NOT the whole request context. Sign-in needs to know that the
 * subject is a known person here and nothing more; the tenant setting, the
 * post-exit window and the roles are resolved per request afterwards, never at
 * sign-in (REQ-016, REQ-022). A field added here is a field somebody will be
 * tempted to cache in the cookie.
 */
export interface LinkedIdentity {
  personId: string;
  tenantId: string;
}

/** Resolves an authenticated subject to the employee it is linked to, or null. */
export type IdentityLookup = (subject: string) => Promise<LinkedIdentity | null>;

export interface SignInDeps {
  transport: OidcTransport;
  config: OidcConfig;
  /** Seals the pending cookie and the session cookie. */
  sealKey: Buffer;
  lookupIdentity: IdentityLookup;
  /** Seconds since epoch. Injected so age checks are testable without waiting. */
  now?: () => number;
}

export interface SetCookie<O> {
  name: string;
  value: string;
  options: O;
}

export interface BegunSignIn {
  authorizationUrl: string;
  pendingCookie: SetCookie<PendingCookieOptions>;
}

/**
 * Step one: build the redirect and remember what we sent.
 *
 * Returns the cookie rather than setting it, so this function is pure enough to
 * test without a request object — and so there is exactly one place (the route)
 * that touches the response.
 */
export async function beginSignIn(deps: SignInDeps, returnTo: string): Promise<BegunSignIn> {
  const { authorizationUrl, pending } = await startSignIn(
    deps.transport,
    deps.config,
    returnTo,
  );
  return {
    authorizationUrl,
    pendingCookie: {
      name: PENDING_COOKIE_NAME,
      value: sealPending(pending, deps.sealKey),
      options: pendingCookieOptions(),
    },
  };
}

export interface FinishedSignIn {
  session: SessionPayload;
  sessionCookie: SetCookie<CookieOptions>;
  /** Always returned, success or failure — the pending record is single-use. */
  clearPendingCookie: SetCookie<PendingCookieOptions>;
  returnTo: string;
  identity: LinkedIdentity;
}

export interface CallbackQuery {
  code?: string | null;
  state?: string | null;
  error?: string | null;
}

/**
 * Step two: the callback.
 *
 * The caller MUST clear the pending cookie whether this resolves or throws.
 * That is what makes a replayed callback fail: a replay carries the correct
 * `state` by construction, so comparing `state` cannot catch it — only the
 * pending record being gone can. `clearPendingCookie` is on the success path,
 * and `SignInError` carries the same instruction for the failure path.
 */
export async function finishSignIn(
  deps: SignInDeps,
  pendingCookieValue: string | undefined,
  query: CallbackQuery,
): Promise<FinishedSignIn> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const pending = unsealPending(pendingCookieValue, deps.sealKey);

  const completed = await completeSignIn(
    deps.transport,
    deps.config,
    pending,
    { code: query.code, state: query.state, error: query.error },
    now(),
  );

  // THE GATE. The token is valid; that is not the question being asked here.
  const identity = await deps.lookupIdentity(completed.subject);
  if (identity === null) {
    // One code, one message, for "no link", "link disabled" and "linked at a
    // different customer". They are the same answer to the caller — you cannot
    // sign in here — and distinguishing them would tell a stranger whether an
    // account exists at this employer, which is REQ-031's whole subject.
    //
    // No row is created. Not here, and not by any code path this function can
    // reach: the application role has no INSERT on `identity_link`.
    throw new SignInError(
      'NOT_LINKED',
      'This account is not linked to an employee record at this organisation.',
    );
  }

  const session = newSession(completed.subject);
  return {
    session,
    sessionCookie: {
      name: SESSION_COOKIE_NAME,
      value: sealSession(session, deps.sealKey),
      options: sessionCookieOptions(),
    },
    clearPendingCookie: { name: PENDING_COOKIE_NAME, ...clearedPendingCookie() },
    returnTo: completed.returnTo,
    identity,
  };
}

/** Clearing a cookie is setting it empty with a zero lifetime, not omitting it. */
export type ClearedCookieOptions = CookieOptions & { maxAge: 0 };

export interface SignedOut {
  clearSessionCookie: SetCookie<ClearedCookieOptions>;
  clearPendingCookie: SetCookie<PendingCookieOptions>;
  /**
   * Where to send the browser to end the session AT THE IDENTITY PROVIDER.
   *
   * `null` only when the issuer publishes no `end_session_endpoint`, and then
   * `identityProviderSessionSurvives` is true and the caller must say so.
   */
  redirectTo: string | null;
  identityProviderSessionSurvives: boolean;
  /** The subject that was signed out, for the audit line. `null` if no session. */
  subject: string | null;
}

/**
 * Sign-out, which is two things, and doing only the first is the bug.
 *
 * Clearing our cookie signs the person out of THIS application and leaves their
 * identity-provider session alone — so the next visit to the sign-in address
 * bounces through Keycloak, finds a live session there, and signs them straight
 * back in without asking anything. On Aisha's own phone that is a mild
 * surprise. On a shared machine in a warehouse it is not a sign-out at all, it
 * is a redirect, and the next person to use that browser is her.
 *
 * So sign-out clears the cookie AND sends the browser to the issuer's
 * `end_session_endpoint`.
 *
 * WHAT THIS DOES NOT SEND, and why: `id_token_hint`. We do not keep the ID
 * token. The session cookie carries `{ sub, iat, sid }` and nothing else, which
 * is what REQ-016 and REQ-022 rest on, and there is no server-side session
 * store in this slice to put a token in. Without the hint, an issuer typically
 * asks the person to confirm the sign-out rather than performing it silently —
 * so sign-out still ends the identity-provider session, but with one extra tap.
 * That is a real cost and it is recorded in the design note as a named
 * follow-up rather than hidden behind a working-looking redirect.
 */
export async function signOut(
  deps: SignInDeps,
  sessionCookieValue: string | undefined,
  postLogoutRedirectUri: string,
): Promise<SignedOut> {
  const session = sessionCookieValue
    ? unsealSession(sessionCookieValue, deps.sealKey)
    : null;

  let endpoint: string | undefined;
  try {
    endpoint = (await deps.transport.discover()).end_session_endpoint;
  } catch {
    // Discovery being down must not trap somebody in a signed-in state. The
    // local cookie is cleared regardless and the caller is told plainly that
    // the identity-provider session survived, which is the honest half-answer.
    endpoint = undefined;
  }

  const redirectTo = endSessionUrl(
    endpoint,
    undefined,
    postLogoutRedirectUri,
    deps.config.clientId,
  );

  return {
    clearSessionCookie: {
      name: SESSION_COOKIE_NAME,
      value: '',
      options: { ...sessionCookieOptions(), maxAge: 0 },
    },
    clearPendingCookie: { name: PENDING_COOKIE_NAME, ...clearedPendingCookie() },
    redirectTo,
    identityProviderSessionSurvives: redirectTo === null,
    subject: session?.sub ?? null,
  };
}

export { SignInError };

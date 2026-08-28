/**
 * The pending sign-in cookie — where `state`, `nonce` and the PKCE verifier
 * live between the redirect out and the callback back.
 *
 * A SEPARATE COOKIE FROM THE SESSION, deliberately. At this point in the flow
 * nobody has been authenticated, so there is no session to put anything in, and
 * writing these values into the session cookie would mean issuing a session
 * cookie to an unauthenticated caller — which is the shape of a session-fixation
 * bug even when this particular version of it is harmless.
 *
 * It is sealed with the same AES-256-GCM primitive as the session, so the
 * browser cannot read or edit it. That matters more than it looks: `state` and
 * `nonce` are only defences while the attacker cannot learn them. A pending
 * record in a plain cookie is a pending record the attacker can copy out of a
 * browser they control and replay into one they do not.
 *
 * SINGLE USE. The callback route clears the cookie BEFORE it does anything with
 * the values, so a second callback carrying the same `state` finds no pending
 * record and is refused as `NO_PENDING_AUTHORIZATION`. That is what makes a
 * replayed callback fail — comparing `state` correctly is not enough on its
 * own, because a replayed callback carries the RIGHT `state` by definition.
 */
import { sealJson, unsealJson } from '../sealed.ts';
import { safeReturnTo, type PendingAuthorization } from './pkce.ts';

export const PENDING_COOKIE_NAME = 'hrms_signin';

/**
 * How long the browser keeps it. Short: this cookie exists only for the round
 * trip to the identity provider and back. It is a ceiling, not the check —
 * `completeSignIn` re-checks the age against `authorizationTtlSeconds` server
 * side, because a cookie's expiry is a request the browser may ignore.
 */
export const PENDING_COOKIE_MAX_AGE_SECONDS = 600;

export interface PendingCookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * `SameSite=Lax`, matching the session cookie.
 *
 * It has to survive one cross-site top-level navigation — the identity provider
 * redirecting the browser back to our callback — which `Lax` allows and
 * `Strict` does not. `Strict` here would drop the cookie on exactly the request
 * the cookie exists for, and every sign-in would fail with
 * `NO_PENDING_AUTHORIZATION`.
 */
export function pendingCookieOptions(): PendingCookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Cleared by setting an empty value with a zero lifetime. */
export function clearedPendingCookie(): { value: string; options: PendingCookieOptions } {
  return { value: '', options: { ...pendingCookieOptions(), maxAge: 0 } };
}

export function sealPending(pending: PendingAuthorization, key: Buffer): string {
  // Named fields, never a spread. A spread would happily carry whatever a
  // future caller attached to the object into a cookie nobody decided about —
  // the same rule `sealSession` follows, for the same reason.
  return sealJson(
    {
      state: pending.state,
      nonce: pending.nonce,
      codeVerifier: pending.codeVerifier,
      returnTo: pending.returnTo,
      createdAt: pending.createdAt,
    },
    key,
  );
}

/**
 * Opens the cookie, or returns `null`.
 *
 * `null` for a missing, tampered, truncated or foreign-key cookie, and `null`
 * for a well-formed cookie whose fields are the wrong shape. The caller turns
 * every one of those into the same refusal, so an attacker learns nothing from
 * which kind of broken cookie they sent.
 */
export function unsealPending(value: string | undefined, key: Buffer): PendingAuthorization | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = unsealJson(value, key);
  if (parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.state !== 'string' || p.state.length === 0 ||
    typeof p.nonce !== 'string' || p.nonce.length === 0 ||
    typeof p.codeVerifier !== 'string' || p.codeVerifier.length === 0 ||
    typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)
  ) {
    return null;
  }
  return {
    state: p.state,
    nonce: p.nonce,
    codeVerifier: p.codeVerifier,
    // Re-validated on the way OUT as well as on the way in. The value was safe
    // when it was sealed, but a cookie is where a value goes to be forgotten
    // about, and an open redirect is a phishing primitive worth checking twice.
    returnTo: safeReturnTo(p.returnTo),
    createdAt: p.createdAt,
  };
}

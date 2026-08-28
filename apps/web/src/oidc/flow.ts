/**
 * The authorization-code flow — SEC-01, SEC-02.
 *
 * Two functions. `startSignIn` builds the URL the browser is sent to;
 * `completeSignIn` handles what comes back. Everything that can be got wrong
 * about OIDC lives in the second one.
 */
import type { OidcConfig, OidcTransport } from './config.ts';
import {
  CODE_CHALLENGE_METHOD,
  beginAuthorization,
  challengeFor,
  matchesOneTimeValue,
  type PendingAuthorization,
} from './pkce.ts';
import { verifyIdToken, IdTokenError, type IdTokenClaims } from './verify.ts';

export class SignInError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SignInError';
    this.code = code;
  }
}

export interface StartedSignIn {
  authorizationUrl: string;
  pending: PendingAuthorization;
}

/**
 * Builds the authorization URL and the one-time values that go with it.
 *
 * `pending` is the caller's to store — in a short-lived cookie of its own, not
 * in the session cookie, because at this point there is no session and the
 * person is not yet anybody.
 */
export async function startSignIn(
  transport: OidcTransport,
  config: OidcConfig,
  returnTo: string,
): Promise<StartedSignIn> {
  const endpoints = await transport.discover();
  const pending = beginAuthorization(returnTo);

  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', challengeFor(pending.codeVerifier));
  // Hard-coded to S256. Not a parameter, not read from configuration, not
  // negotiated — `plain` sends the proof in the clear on the first request and
  // provides no protection at all, while looking like a working PKCE flow.
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);

  return { authorizationUrl: url.toString(), pending };
}

export interface CallbackParams {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}

export interface CompletedSignIn {
  subject: string;
  claims: IdTokenClaims;
  returnTo: string;
}

/**
 * Handles the callback. Six checks, in this order, and the order matters:
 * nothing is exchanged or trusted before we know the callback belongs to a
 * sign-in this browser actually started.
 */
export async function completeSignIn(
  transport: OidcTransport,
  config: OidcConfig,
  pending: PendingAuthorization | null,
  params: CallbackParams,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CompletedSignIn> {
  // 1. The issuer said no. Surface that it failed, never the description —
  //    it is attacker-influenced text and would be rendered on our page.
  if (params.error) {
    throw new SignInError('AUTHORIZATION_DENIED', `Authorization failed: ${params.error}`);
  }

  // 2. There must be a pending sign-in at all. A callback arriving with no
  //    pending record is either a stale tab or a forged request; both are
  //    refused the same way.
  if (!pending) {
    throw new SignInError(
      'NO_PENDING_AUTHORIZATION',
      'This sign-in did not start here, or it has already been used.',
    );
  }

  // 3. It must not be ancient. A pending sign-in that never expires is a state
  //    value an attacker can take their time with.
  if (now - pending.createdAt > config.authorizationTtlSeconds) {
    throw new SignInError('AUTHORIZATION_EXPIRED', 'This sign-in took too long. Start again.');
  }

  // 4. STATE — the cross-site request forgery defence, and the one most often
  //    left out because the flow works without it.
  //
  //    Without this check an attacker can start their OWN sign-in, capture the
  //    resulting code, and then trick a signed-out victim's browser into
  //    visiting our callback with it. The victim is then silently signed in as
  //    the ATTACKER, and anything they do next — correcting a phone number,
  //    downloading data — happens in the attacker's account, where the attacker
  //    can read it. Compared in constant time, because a leaked `state` is a
  //    forgeable callback.
  if (!params.state || !matchesOneTimeValue(pending.state, params.state)) {
    throw new SignInError('STATE_MISMATCH', 'This sign-in did not start in this browser.');
  }

  if (!params.code) {
    throw new SignInError('NO_CODE', 'The issuer returned no authorization code.');
  }

  // 5. Exchange, sending the PKCE verifier. Only now, and only once state has
  //    been checked, does anything leave this process.
  const tokens = await transport.exchangeCode({
    code: params.code,
    codeVerifier: pending.codeVerifier,
    redirectUri: config.redirectUri,
  });

  if (!tokens.id_token) {
    throw new SignInError('NO_ID_TOKEN', 'The issuer returned no ID token.');
  }

  // 6. Verify the ID token properly: signature against the issuer's published
  //    keys, with an algorithm allowlist we choose, plus issuer, audience,
  //    expiry and the nonce we issued.
  let claims: IdTokenClaims;
  try {
    claims = await verifyIdToken({
      idToken: tokens.id_token,
      jwks: await transport.jwks(),
      issuer: config.issuer,
      audience: config.clientId,
      expectedNonce: pending.nonce,
    });
  } catch (err) {
    if (err instanceof IdTokenError) {
      throw new SignInError(err.code, err.message);
    }
    throw err;
  }

  return { subject: claims.sub, claims, returnTo: pending.returnTo };
}

/**
 * RP-initiated logout — the URL that ends the session at the issuer, not just here.
 *
 * Clearing our own cookie signs the person out of THIS application and leaves
 * their identity-provider session alone, so the next visit silently signs them
 * straight back in. On a shared machine that is not a sign-out at all, it is a
 * redirect. So sign-out clears the cookie AND sends the browser here.
 *
 * Returns `null` when the issuer publishes no `end_session_endpoint`. The
 * caller must then still clear the local cookie and must say plainly that the
 * identity-provider session survives — a sign-out that silently does half the
 * job is worse than one that admits it.
 */
export function endSessionUrl(
  endSessionEndpoint: string | undefined,
  idTokenHint: string | undefined,
  postLogoutRedirectUri: string,
  clientId: string,
): string | null {
  if (!endSessionEndpoint) return null;
  const url = new URL(endSessionEndpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  return url.toString();
}

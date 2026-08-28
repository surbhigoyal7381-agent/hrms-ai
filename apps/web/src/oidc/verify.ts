/**
 * Verifying the ID token — SEC-01.
 *
 * This is the step that is most often stubbed to "decode and trust" during
 * development and then never revisited, because a decoded token and a verified
 * token look identical in every log, every screen and every happy-path test.
 * The difference only shows under attack.
 *
 * Verification is delegated to `jose` (6.2.10, MIT — verified in the installed
 * package, not assumed) rather than hand-rolled. Hand-written JWT verification
 * is where `alg: none` and algorithm-confusion bugs come from.
 */
import { jwtVerify, createLocalJWKSet, type JSONWebKeySet, type JWTPayload } from 'jose';
import { matchesOneTimeValue } from './pkce.ts';

/**
 * The algorithms we accept, as an allowlist passed to the verifier.
 *
 * Two attacks are refused by this one line:
 *
 *   `alg: none`  — a token with no signature at all. A verifier that honours
 *                  the token's own `alg` header accepts it, because the token
 *                  says it needs no signature and the verifier believes it.
 *   confusion    — a token signed with HMAC using the issuer's PUBLIC key as
 *                  the shared secret. A verifier that picks the algorithm from
 *                  the header will happily verify it, because the public key is
 *                  public.
 *
 * The fix for both is the same and it is structural: the RELYING PARTY decides
 * which algorithms are acceptable, never the token.
 */
export const ACCEPTED_ALGORITHMS = Object.freeze(['RS256', 'ES256'] as const);

export interface IdTokenClaims extends JWTPayload {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nonce?: string;
}

export class IdTokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IdTokenError';
    this.code = code;
  }
}

export interface VerifyOptions {
  idToken: string;
  jwks: JSONWebKeySet;
  issuer: string;
  audience: string;
  /** The nonce this browser was issued. Required — see below. */
  expectedNonce: string;
  /** Seconds of leeway for clock skew between us and the issuer. */
  clockToleranceSeconds?: number;
}

/**
 * Verifies signature, issuer, audience, expiry and nonce. All five, or it throws.
 *
 * Every one of these has a failure mode that leaves a working-looking sign-in:
 *
 *   signature  — anyone can mint a token
 *   iss        — a token from a different issuer is accepted, so any identity
 *                provider in the world can authenticate as our users
 *   aud        — a token minted for a DIFFERENT application is accepted; that
 *                other application's operator can then sign in as its users here
 *   exp        — a token stolen from a log last year still works
 *   nonce      — a token captured once can be replayed
 */
export async function verifyIdToken(opts: VerifyOptions): Promise<IdTokenClaims> {
  if (typeof opts.idToken !== 'string' || opts.idToken.length === 0) {
    throw new IdTokenError('ID_TOKEN_MISSING', 'No ID token was returned.');
  }
  // Checked before verifying rather than after: a caller that forgot to carry
  // the nonce through the flow would otherwise get a token that verifies, and
  // the replay defence would be silently absent.
  if (typeof opts.expectedNonce !== 'string' || opts.expectedNonce.length === 0) {
    throw new IdTokenError(
      'NONCE_NOT_ISSUED',
      'No nonce was recorded for this sign-in, so replay cannot be ruled out.',
    );
  }

  const keys = createLocalJWKSet(opts.jwks);

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(opts.idToken, keys, {
      // The allowlist. Not read from the token's own header.
      algorithms: [...ACCEPTED_ALGORITHMS],
      issuer: opts.issuer,
      audience: opts.audience,
      clockTolerance: opts.clockToleranceSeconds ?? 30,
    }));
  } catch (err) {
    // The reason is logged for operators, never returned to the caller: which
    // check failed is information an attacker uses to iterate.
    throw new IdTokenError(
      'ID_TOKEN_INVALID',
      `ID token failed verification: ${(err as Error).message}`,
    );
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new IdTokenError('ID_TOKEN_NO_SUBJECT', 'ID token carries no subject.');
  }
  if (typeof payload.exp !== 'number') {
    throw new IdTokenError('ID_TOKEN_NO_EXPIRY', 'ID token carries no expiry.');
  }

  const nonce = payload.nonce;
  if (typeof nonce !== 'string' || !matchesOneTimeValue(opts.expectedNonce, nonce)) {
    throw new IdTokenError(
      'NONCE_MISMATCH',
      'ID token nonce does not match the one issued for this sign-in.',
    );
  }

  return payload as IdTokenClaims;
}

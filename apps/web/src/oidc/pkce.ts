/**
 * PKCE, and the two one-time values the flow depends on — SEC-01.
 *
 * PKCE ("proof key for code exchange") stops somebody who intercepts the
 * authorization code from redeeming it: the code is only usable by whoever
 * holds the secret it was requested with.
 *
 * Three separate random values, and they do three different jobs. They get
 * confused constantly, so:
 *
 *   verifier  proves the client redeeming the code is the one that asked for it
 *   state     proves the callback belongs to a sign-in THIS browser started
 *             — the cross-site request forgery defence
 *   nonce     proves the ID token was minted for THIS sign-in, not replayed
 *             from an older one
 *
 * Dropping any one of them leaves a flow that works perfectly in a browser and
 * is broken in a way no manual test finds.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * S256 only. `plain` is in the specification and must never be offered.
 *
 * With `plain` the "proof" is sent in the clear on the first request, so
 * anybody who sees that request can redeem the code — which is the exact attack
 * PKCE exists to stop. A downgrade to `plain` is the classic way to make a flow
 * look compliant while providing no protection at all, and an authorization
 * server that accepts it will not complain.
 */
export const CODE_CHALLENGE_METHOD = 'S256' as const;
export type CodeChallengeMethod = typeof CODE_CHALLENGE_METHOD;

/** 32 bytes, base64url — comfortably inside the specification's 43–128 characters. */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

export function createNonce(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Compares two one-time values without leaking their contents through timing.
 *
 * `a === b` on a `state` returns as soon as it finds a differing character, so
 * an attacker who can time the callback can recover the value one character at
 * a time and then forge a callback. Length is compared first because
 * `timingSafeEqual` throws on a length mismatch, and a thrown error is itself a
 * signal — so a wrong length returns `false` the same way a wrong value does.
 */
export function matchesOneTimeValue(expected: string, received: string): boolean {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  if (expected.length === 0 || received.length === 0) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Everything one sign-in attempt needs to remember until the callback arrives. */
export interface PendingAuthorization {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to send the person afterwards. Validated as a relative path. */
  returnTo: string;
  /** Seconds since epoch, so a pending sign-in can be aged out. */
  createdAt: number;
}

export function beginAuthorization(returnTo: string): PendingAuthorization {
  return {
    state: createState(),
    nonce: createNonce(),
    codeVerifier: createCodeVerifier(),
    returnTo: safeReturnTo(returnTo),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * An open redirect is a phishing primitive: a link that genuinely starts at our
 * domain and lands on somebody else's, which is exactly what makes a
 * credential-harvesting page believable. Only same-site absolute paths survive.
 */
export function safeReturnTo(candidate: unknown): string {
  if (typeof candidate !== 'string' || candidate.length === 0) return '/';
  // `//evil.example` and `/\evil.example` are protocol-relative URLs, not paths.
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if (candidate.includes('://')) return '/';
  // A newline lets a crafted value smuggle a header in some servers.
  if (/[\r\n]/.test(candidate)) return '/';
  return candidate;
}

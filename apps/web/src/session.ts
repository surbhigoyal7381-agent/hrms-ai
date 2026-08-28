/**
 * The session cookie — REQ-016, REQ-022, SEC-01, SEC-09.
 *
 * It carries an identifier and NOTHING ELSE.
 *
 *   { sub, iat, sid }
 *
 * No tenant id. No employment id. No roles. No setting state. No post-exit
 * flag. Every one of those is resolved from the database on every request by
 * `resolveRequestContext`.
 *
 * This is not belt-and-braces, it is the requirement. REQ-016 says the
 * organisation switch "is evaluated from the store on every request and is
 * never read from a session claim, a cached flag, or a JWT" — so that Priya
 * switching it off at 11:02 takes effect at 11:03 rather than whenever a token
 * expires. REQ-022 says the post-exit window is "re-evaluated per request
 * against the exit date, never from a claim baked into the token at sign-in".
 *
 * The general rule underneath both: **a value that is not in the cookie cannot
 * be stale and cannot be forged.** Adding a claim here to save a query is
 * trading a correctness property for a millisecond, and the query it would save
 * is a single indexed lookup that we make anyway.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Everything the cookie is allowed to contain. */
export interface SessionPayload {
  /** The identity provider's subject claim. */
  sub: string;
  /** Issued-at, seconds since epoch. The basis for lifetime enforcement later. */
  iat: number;
  /** Opaque session id, so a single session can be revoked without the subject. */
  sid: string;
}

/**
 * The exact key set, exported so a test can assert it rather than describe it.
 * If somebody adds a claim, they have to add it here too — and the test that
 * decrypts a real cookie and compares raw JSON keys will fail either way.
 */
export const ALLOWED_SESSION_KEYS: readonly string[] = Object.freeze(['sub', 'iat', 'sid']);

export const SESSION_COOKIE_NAME = 'hrms_session';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SessionKeyError extends Error {}
export class SessionDecodeError extends Error {}

/**
 * Reads the sealing key. 32 bytes, base64.
 *
 * Fails loudly and at startup rather than falling back to a generated key: a
 * process that invents its own key signs sessions nobody else can read, which
 * looks like random sign-outs under a load balancer and is diagnosed as a bug
 * in something else entirely.
 */
export function loadSessionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SESSION_COOKIE_KEY;
  if (!raw) {
    throw new SessionKeyError(
      'SESSION_COOKIE_KEY is not set. Generate one with:\n' +
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new SessionKeyError(
      `SESSION_COOKIE_KEY must decode to 32 bytes, got ${key.length}.`,
    );
  }
  return key;
}

export function newSession(sub: string): SessionPayload {
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    throw new SessionDecodeError('A session needs a subject.');
  }
  return {
    sub,
    iat: Math.floor(Date.now() / 1000),
    sid: randomBytes(16).toString('base64url'),
  };
}

/**
 * Encrypts a payload for the cookie.
 *
 * Built by naming the three fields explicitly rather than serialising whatever
 * was passed in. An object spread here would happily carry a `tenantId` that
 * some future caller attached, and the cookie would silently start holding a
 * claim nobody decided to put there.
 */
export function sealSession(payload: SessionPayload, key: Buffer): string {
  const body: SessionPayload = {
    sub: payload.sub,
    iat: payload.iat,
    sid: payload.sid,
  };
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(body), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Decrypts a cookie, or returns `null`.
 *
 * Returns null rather than throwing for anything an attacker controls —
 * tampering, truncation, a cookie sealed with a rotated key. The caller treats
 * "no session" and "a session I cannot read" identically, which is what stops
 * the difference being observable.
 */
export function unsealSession(value: string, key: Buffer): SessionPayload | null {
  try {
    const raw = Buffer.from(value, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.sub !== 'string' || typeof p.iat !== 'number' || typeof p.sid !== 'string') {
      return null;
    }
    // Only the three fields are returned, whatever the ciphertext held. A
    // cookie carrying an extra claim cannot smuggle it into the request.
    return { sub: p.sub, iat: p.iat, sid: p.sid };
  } catch {
    return null;
  }
}

/** Constant-time compare, for anything that ever compares session ids. */
export function sameSession(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface CookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
}

/**
 * `SameSite=Lax`, not `Strict` and not `None`.
 *
 * `None` would send the cookie on any cross-site request, which is the CSRF
 * hole. `Strict` would drop the cookie when an employee follows a link to their
 * record from an email or a chat message — the ordinary way somebody arrives
 * here — and they would land signed out with no explanation. `Lax` sends it on
 * a top-level navigation and withholds it from cross-site form posts.
 */
export function sessionCookieOptions(): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
}

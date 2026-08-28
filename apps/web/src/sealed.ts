/**
 * Sealing a small JSON value into a cookie — AES-256-GCM.
 *
 * Two cookies need this now: the session (`session.ts`) and the short-lived
 * pending-sign-in record (`oidc/pending-cookie.ts`). They are different values
 * with different lifetimes, but the sealing is the same, and the one thing you
 * must never do with cryptographic code is write it twice — the second copy is
 * where the nonce gets reused or the tag gets dropped.
 *
 * Layout, and it is not negotiable:
 *
 *     [ 12-byte IV ][ 16-byte GCM tag ][ ciphertext ]   base64url
 *
 * GCM is authenticated encryption: tampering with any byte makes `final()`
 * throw rather than yielding altered plaintext. That is what makes it safe to
 * put a value in a cookie the browser can see and edit.
 *
 * A FRESH IV EVERY TIME. Reusing one under the same key breaks GCM
 * catastrophically — not "weakens", breaks: two messages under one IV leak
 * their XOR and let an attacker forge tags. There is no code path here that
 * accepts an IV from a caller.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SealKeyError extends Error {}

/**
 * Reads a 32-byte base64 key from the environment, or refuses to start.
 *
 * Never generates one as a fallback. A process that invents its own key seals
 * values no other instance can open, which appears as random sign-outs behind a
 * load balancer and gets diagnosed as a bug in something else entirely.
 */
export function loadSealKey(name: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[name];
  if (!raw) {
    throw new SealKeyError(
      `${name} is not set. Generate one with:\n` +
      "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new SealKeyError(`${name} must decode to 32 bytes, got ${key.length}.`);
  }
  return key;
}

export function sealJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Opens a sealed value, or returns `null`.
 *
 * `null` for everything an attacker controls — tampering, truncation, a value
 * sealed with a rotated key, JSON that is not an object. Never a throw: the
 * caller must treat "no cookie" and "a cookie I cannot open" identically, and
 * an exception invites a `catch` somewhere that carries on with a half-state.
 */
export function unsealJson(value: string, key: Buffer): unknown {
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
    return parsed;
  } catch {
    return null;
  }
}

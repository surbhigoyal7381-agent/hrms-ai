import { describe, it, expect } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import {
  sealSession,
  unsealSession,
  newSession,
  loadSessionKey,
  sessionCookieOptions,
  sameSession,
  ALLOWED_SESSION_KEYS,
  SESSION_COOKIE_NAME,
  SessionKeyError,
} from '../src/session.ts';

const KEY = Buffer.alloc(32, 7);

/**
 * Decrypts a cookie WITHOUT going through `unsealSession`.
 *
 * This is the independent oracle, and the whole point of it. `unsealSession`
 * rebuilds a three-field object, so a claim smuggled into the ciphertext would
 * be invisible to any assertion made through it — the test would pass while the
 * cookie carried a tenant id. So this reimplements only the decryption, and
 * returns the RAW parsed JSON.
 */
function decryptRaw(cookie: string, key: Buffer): Record<string, unknown> {
  const raw = Buffer.from(cookie, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

describe('the cookie carries an identifier and NOTHING else', () => {
  it('an actually-issued cookie contains exactly sub, iat and sid', async () => {
    const cookie = sealSession(newSession('kc-abc-123'), KEY);
    const raw = decryptRaw(cookie, KEY);

    // Asserted on the decrypted BYTES, not on the interface. A test that
    // checked the TypeScript shape would stay green while somebody quietly
    // added a claim to the payload.
    expect(Object.keys(raw).sort()).toEqual([...ALLOWED_SESSION_KEYS].sort());
  });

  it('names the forbidden claims explicitly, so a reviewer can see the list', async () => {
    const cookie = sealSession(newSession('kc-abc-123'), KEY);
    const raw = decryptRaw(cookie, KEY);

    // REQ-016: the setting is never read from a session claim.
    // REQ-022: the window is never read from a claim baked in at sign-in.
    // Every one of these must be resolved per request, from the database.
    for (const forbidden of [
      'tenantId', 'tenant_id', 'tenant',
      'employmentId', 'employment_id', 'employment',
      'personId', 'person_id',
      'roles', 'role', 'permissions', 'scopes',
      'recordViewEnabled', 'record_view_enabled', 'settingState', 'tenantSetting',
      'postExit', 'post_exit', 'postExitSession', 'exitDate', 'exit_date',
      'lifecycle', 'status',
    ]) {
      expect(raw[forbidden], `the cookie carries "${forbidden}"`).toBeUndefined();
    }
  });

  it('drops a claim smuggled in by a caller rather than carrying it', async () => {
    // `sealSession` names its three fields instead of spreading whatever it was
    // given. A future caller attaching a tenant id — to "save a lookup" — gets
    // it silently discarded rather than silently persisted.
    const smuggled = { ...newSession('kc-abc-123'), tenantId: 'tenant-A', roles: ['hr_admin'] };
    const raw = decryptRaw(sealSession(smuggled as never, KEY), KEY);
    expect(Object.keys(raw).sort()).toEqual([...ALLOWED_SESSION_KEYS].sort());
    expect(raw.tenantId).toBeUndefined();
    expect(raw.roles).toBeUndefined();
  });
});

describe('sealing and unsealing', () => {
  it('round-trips a session', async () => {
    // Positive control: every assertion above is about what is ABSENT, and all
    // of them would pass for a function that produced an empty cookie.
    const session = newSession('kc-abc-123');
    const back = unsealSession(sealSession(session, KEY), KEY);
    expect(back).toEqual(session);
    expect(back!.sub).toBe('kc-abc-123');
  });

  it('two cookies for the same subject differ, and each still decodes', async () => {
    // A deterministic cookie would leak that two requests are the same person
    // to anyone who can see the header, and would make replay trivial.
    const a = sealSession(newSession('kc-abc-123'), KEY);
    const b = sealSession(newSession('kc-abc-123'), KEY);
    expect(a).not.toBe(b);
    expect(unsealSession(a, KEY)!.sub).toBe('kc-abc-123');
    expect(unsealSession(b, KEY)!.sub).toBe('kc-abc-123');
  });

  it('refuses a tampered cookie, a truncated one, and the wrong key', async () => {
    const cookie = sealSession(newSession('kc-abc-123'), KEY);

    const flipped = Buffer.from(cookie, 'base64url');
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    expect(unsealSession(flipped.toString('base64url'), KEY), 'tampering accepted').toBeNull();

    expect(unsealSession(cookie.slice(0, 20), KEY), 'truncation accepted').toBeNull();
    expect(unsealSession('', KEY)).toBeNull();
    expect(unsealSession('not-base64-at-all!!', KEY)).toBeNull();
    expect(unsealSession(cookie, Buffer.alloc(32, 9)), 'wrong key accepted').toBeNull();
  });

  it('returns null rather than throwing, so a bad cookie is indistinguishable from none', async () => {
    // The caller treats "no session" and "a session I cannot read" the same
    // way. A thrown error would need a different response path, and a different
    // response is an oracle.
    expect(() => unsealSession('garbage', KEY)).not.toThrow();
  });
});

describe('cookie attributes and key handling', () => {
  it('is HttpOnly, Secure, SameSite=Lax, path /', async () => {
    expect(sessionCookieOptions()).toEqual({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
    });
    expect(SESSION_COOKIE_NAME).toBe('hrms_session');
  });

  it('refuses to start without a key, and refuses a short one', async () => {
    expect(() => loadSessionKey({} as unknown as NodeJS.ProcessEnv)).toThrow(SessionKeyError);
    expect(() => loadSessionKey({ SESSION_COOKIE_KEY: 'c2hvcnQ=' } as unknown as NodeJS.ProcessEnv))
      .toThrow(/32 bytes/);
    const good = randomBytes(32).toString('base64');
    expect(loadSessionKey({ SESSION_COOKIE_KEY: good } as unknown as NodeJS.ProcessEnv)).toHaveLength(32);
  });

  it('compares session ids in constant time', async () => {
    expect(sameSession('abc', 'abc')).toBe(true);
    expect(sameSession('abc', 'abd')).toBe(false);
    expect(sameSession('abc', 'abcd')).toBe(false);
  });
});

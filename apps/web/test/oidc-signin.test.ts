import { describe, it, expect, vi } from 'vitest';
import {
  beginSignIn,
  finishSignIn,
  signOut,
  SignInError,
  type SignInDeps,
} from '../src/oidc/signin.ts';
import {
  PENDING_COOKIE_NAME,
  sealPending,
  unsealPending,
} from '../src/oidc/pending-cookie.ts';
import { SESSION_COOKIE_NAME, unsealSession, ALLOWED_SESSION_KEYS } from '../src/session.ts';
import { unsealJson } from '../src/sealed.ts';
import {
  CLIENT_ID,
  jwksOf,
  makeKeypair,
  mintIdToken,
  syntheticIssuer,
  testConfig,
} from './support/synthetic-issuer.ts';

/**
 * Sign-in end to end — REQ-016, REQ-022, SEC-01, SEC-09.
 *
 * The property this file exists for is the one the OIDC specification has no
 * opinion about: AUTHENTICATING IS NOT THE SAME AS BEING AN EMPLOYEE. A valid
 * ID token for a subject with no `identity_link` row is refused, and no link is
 * created.
 */

const KEY = Buffer.alloc(32, 7);
const key = await makeKeypair();
const jwks = await jwksOf(key);

const AISHA = { personId: 'p-aisha', tenantId: 't-northwind' };

/**
 * One sign-in attempt, wired to a synthetic issuer.
 *
 * `linked` is the set of subjects that HAVE an `identity_link` row. Nothing in
 * the code under test may add to it — that is the property. A production lookup
 * could not add to it either: `identity_link` has INSERT revoked from
 * `hrms_app` in migration 0005, asserted separately against a real database in
 * `packages/core/test/identity-link.test.ts`.
 */
function harness(linked: Set<string>, subject = 'kc-aisha-0001') {
  // The nonce a conforming issuer echoes is the one it received on the
  // authorization request, so it is captured when the sign-in starts.
  let nonce = '';
  const asked: string[] = [];

  const issuer = syntheticIssuer({
    jwks,
    tokenFor: async () => ({ id_token: await mintIdToken({ key, nonce, subject }) }),
  });

  const deps: SignInDeps = {
    transport: issuer.transport,
    config: testConfig(),
    sealKey: KEY,
    lookupIdentity: async (s: string) => {
      asked.push(s);
      return linked.has(s) ? { ...AISHA } : null;
    },
  };

  return {
    deps,
    issuer,
    asked,
    async begin(returnTo = '/record') {
      const begun = await beginSignIn(deps, returnTo);
      const pending = unsealPending(begun.pendingCookie.value, KEY)!;
      nonce = pending.nonce;
      return { begun, pending };
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<SignInError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SignInError) return err;
    throw err;
  }
  throw new Error('the sign-in was ACCEPTED — expected a refusal');
}

describe('an authenticated subject with no identity link is DENIED', () => {
  it('refuses, with no session cookie and no link created', async () => {
    const linked = new Set<string>(); // nobody is linked
    const h = harness(linked, 'kc-stranger-9999');
    const { begun, pending } = await h.begin();

    const err = await refusal(
      finishSignIn(h.deps, begun.pendingCookie.value, {
        code: 'authz-code-1',
        state: pending.state,
      }),
    );
    expect(err.code, 'an unlinked subject was signed in').toBe('NOT_LINKED');

    // The lookup was genuinely consulted with the authenticated subject —
    // otherwise "denied" could mean the flow failed earlier for some unrelated
    // reason and this test would prove nothing about provisioning.
    expect(h.asked).toEqual(['kc-stranger-9999']);

    // And nothing was created. The set the lookup reads is still empty.
    expect(linked.size, 'a link was auto-provisioned').toBe(0);
  });

  it('positive control: the SAME flow succeeds once the link exists', async () => {
    // Without this, the test above would pass just as happily if sign-in were
    // broken for everybody. The only difference between the two is one row.
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin();
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'authz-code-1',
      state: pending.state,
    });
    expect(done.session.sub).toBe('kc-aisha-0001');
    expect(done.identity).toEqual(AISHA);
  });

  it('gives the same refusal for a disabled link as for no link at all', async () => {
    // `resolveRequestContext` filters `disabled_at IS NULL`, so a disabled link
    // resolves to null. Distinguishing the two would tell a stranger whether an
    // account exists at this employer — REQ-031's subject exactly.
    const h = harness(new Set(), 'kc-departed-0002');
    const { begun, pending } = await h.begin();
    const err = await refusal(
      finishSignIn(h.deps, begun.pendingCookie.value, { code: 'c', state: pending.state }),
    );
    expect(err.code).toBe('NOT_LINKED');
    expect(err.message).not.toContain('kc-departed-0002');
  });

  it('never consults the lookup when the token itself is bad', async () => {
    // Ordering: identity resolution happens after verification, never before.
    // A lookup driven by an unverified `sub` is a database query an attacker
    // chooses the argument to.
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun } = await h.begin();
    await refusal(
      finishSignIn(h.deps, begun.pendingCookie.value, { code: 'c', state: 'wrong-state' }),
    );
    expect(h.asked).toEqual([]);
  });
});

describe('the session cookie carries an identifier and nothing else', () => {
  it('holds exactly sub, iat and sid — no tenant, no roles, no setting', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin();
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'c', state: pending.state,
    });

    expect(done.sessionCookie.name).toBe(SESSION_COOKIE_NAME);

    // Read the raw sealed JSON, NOT through `unsealSession` — that function
    // picks three fields on the way out, so it would hide a fourth field that
    // was actually written into the cookie.
    const raw = unsealJson(done.sessionCookie.value, KEY) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([...ALLOWED_SESSION_KEYS].sort());

    // REQ-016 and REQ-022 rest on this: the tenant, the setting and the exit
    // window are resolved per request and cannot be carried in a token.
    expect(JSON.stringify(raw)).not.toContain(AISHA.tenantId);
    expect(JSON.stringify(raw)).not.toContain(AISHA.personId);

    expect(unsealSession(done.sessionCookie.value, KEY)!.sub).toBe('kc-aisha-0001');
  });

  it('is HttpOnly, Secure and SameSite=Lax', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin();
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'c', state: pending.state,
    });
    expect(done.sessionCookie.options).toEqual({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/',
    });
  });

  it('returns the same-site path the sign-in started from', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin('/record?tab=history');
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'c', state: pending.state,
    });
    expect(done.returnTo).toBe('/record?tab=history');
  });

  it('drops an off-site returnTo rather than following it', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin('https://evil.example/harvest');
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'c', state: pending.state,
    });
    expect(done.returnTo).toBe('/');
  });
});

describe('the pending cookie', () => {
  it('is sealed — state, nonce and verifier are not readable by the browser', async () => {
    const { begun, pending } = await harness(new Set(['kc-aisha-0001'])).begin();
    expect(begun.pendingCookie.name).toBe(PENDING_COOKIE_NAME);
    expect(begun.pendingCookie.value).not.toContain(pending.state);
    expect(begun.pendingCookie.value).not.toContain(pending.nonce);
    expect(begun.pendingCookie.value).not.toContain(pending.codeVerifier);
    expect(begun.pendingCookie.options).toMatchObject({
      httpOnly: true, secure: true, sameSite: 'lax',
    });
  });

  it('refuses a tampered, truncated or foreign-key pending cookie', async () => {
    const p = { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/', createdAt: 1 };
    const sealed = sealPending(p, KEY);
    expect(unsealPending(sealed, KEY)).toEqual(p);

    const flipped = Buffer.from(sealed, 'base64url');
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0xff;
    expect(unsealPending(flipped.toString('base64url'), KEY)).toBeNull();
    expect(unsealPending(sealed.slice(0, 20), KEY)).toBeNull();
    expect(unsealPending(sealed, Buffer.alloc(32, 9))).toBeNull();
    expect(unsealPending(undefined, KEY)).toBeNull();
    expect(unsealPending('', KEY)).toBeNull();
  });

  it('re-checks returnTo when opening the cookie, not only when sealing it', async () => {
    // A hand-built cookie sealed with our key — the shape a key leak produces.
    // The open redirect is refused on the way out as well as on the way in.
    const hostile = sealPending(
      { state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '//evil.example', createdAt: 1 },
      KEY,
    );
    expect(unsealPending(hostile, KEY)!.returnTo).toBe('/');
  });

  it('is cleared on the success path, so a replay finds nothing', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin();
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'c', state: pending.state,
    });
    expect(done.clearPendingCookie.name).toBe(PENDING_COOKIE_NAME);
    expect(done.clearPendingCookie.value).toBe('');
    expect(done.clearPendingCookie.options.maxAge).toBe(0);
  });

  it('refuses a callback whose pending cookie is missing', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { pending } = await h.begin();
    const err = await refusal(
      finishSignIn(h.deps, undefined, { code: 'c', state: pending.state }),
    );
    expect(err.code).toBe('NO_PENDING_AUTHORIZATION');
  });
});

describe('sign-out', () => {
  const postLogout = 'https://northwind.thrive.app/signin/signed-out';

  it('clears the local cookie AND redirects to the issuer', async () => {
    const h = harness(new Set(['kc-aisha-0001']));
    const { begun, pending } = await h.begin();
    const done = await finishSignIn(h.deps, begun.pendingCookie.value, {
      code: 'c', state: pending.state,
    });

    const out = await signOut(h.deps, done.sessionCookie.value, postLogout);

    expect(out.clearSessionCookie.value).toBe('');
    expect(out.clearSessionCookie.options.maxAge).toBe(0);
    expect(out.subject).toBe('kc-aisha-0001');

    // The half that is usually missing. Clearing our own cookie alone leaves
    // the identity-provider session alive, so the next visit signs the person
    // straight back in — which on a shared machine is not a sign-out at all.
    expect(out.redirectTo).not.toBeNull();
    const url = new URL(out.redirectTo!);
    expect(url.pathname).toContain('logout');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(postLogout);
    expect(out.identityProviderSessionSurvives).toBe(false);
  });

  it('says so plainly when the issuer publishes no logout endpoint', async () => {
    const issuer = syntheticIssuer({
      jwks, tokenFor: () => ({}), endpoints: { end_session_endpoint: undefined },
    });
    const out = await signOut(
      { transport: issuer.transport, config: testConfig(), sealKey: KEY,
        lookupIdentity: async () => null },
      undefined, postLogout,
    );
    expect(out.redirectTo).toBeNull();
    // Not a silent half-sign-out. The caller has to tell the person.
    expect(out.identityProviderSessionSurvives).toBe(true);
    expect(out.clearSessionCookie.options.maxAge).toBe(0);
  });

  it('still clears the local cookie when discovery is down', async () => {
    const failing = {
      discover: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      jwks: vi.fn(),
      exchangeCode: vi.fn(),
    };
    const out = await signOut(
      { transport: failing, config: testConfig(), sealKey: KEY,
        lookupIdentity: async () => null },
      undefined, postLogout,
    );
    expect(out.clearSessionCookie.options.maxAge).toBe(0);
    expect(out.redirectTo).toBeNull();
    expect(out.identityProviderSessionSurvives).toBe(true);
  });

  it('works on a session cookie it cannot read, rather than throwing', async () => {
    const out = await signOut(harness(new Set()).deps, 'not-a-cookie-we-sealed', postLogout);
    expect(out.subject).toBeNull();
    expect(out.clearSessionCookie.options.maxAge).toBe(0);
    expect(out.redirectTo).not.toBeNull();
  });
});

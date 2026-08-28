import { describe, it, expect } from 'vitest';
import { completeSignIn, startSignIn, endSessionUrl, SignInError } from '../src/oidc/flow.ts';
import { beginAuthorization, type PendingAuthorization } from '../src/oidc/pkce.ts';
import {
  CLIENT_ID,
  ISSUER,
  expectedS256Challenge,
  jwksOf,
  makeKeypair,
  mintIdToken,
  syntheticIssuer,
  testConfig,
} from './support/synthetic-issuer.ts';

/**
 * The callback — SEC-01.
 *
 * `state` is the check most often dropped, because a flow works perfectly
 * without it. What it defends against does not show up in any manual test:
 * an attacker starts their OWN sign-in, captures the resulting code, and
 * feeds it to a signed-out victim's browser at our callback URL. The victim
 * is silently signed in AS THE ATTACKER, and every private thing they do next
 * — correcting a phone number, downloading their data — happens inside an
 * account the attacker can read at leisure.
 */

const key = await makeKeypair();
const jwks = await jwksOf(key);

interface Harness {
  issuer: ReturnType<typeof syntheticIssuer>;
  pending: PendingAuthorization;
}

/** A sign-in that has been started, with a conforming issuer waiting. */
async function started(nonceOverride?: string): Promise<Harness> {
  const issuer = syntheticIssuer({
    jwks,
    tokenFor: async () => ({
      id_token: await mintIdToken({ key, nonce: nonceOverride ?? pending.nonce }),
    }),
  });
  const { pending } = await startSignIn(issuer.transport, testConfig(), '/record');
  return { issuer, pending };
}

async function refusal(promise: Promise<unknown>): Promise<SignInError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SignInError) return err;
    throw err;
  }
  throw new Error('the callback was ACCEPTED — expected a refusal');
}

describe('positive control: a well-formed callback completes', () => {
  it('exchanges the code and returns the subject', async () => {
    const { issuer, pending } = await started();
    const done = await completeSignIn(issuer.transport, testConfig(), pending, {
      code: 'authz-code-1',
      state: pending.state,
    });
    expect(done.subject).toBe('kc-aisha-0001');
    expect(done.returnTo).toBe('/record');
  });
});

describe('state', () => {
  it('refuses a callback with NO state', async () => {
    const { issuer, pending } = await started();
    const err = await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, { code: 'c' }),
    );
    expect(err.code).toBe('STATE_MISMATCH');
  });

  it('refuses a callback with the WRONG state', async () => {
    const { issuer, pending } = await started();
    const err = await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, {
        code: 'c',
        state: beginAuthorization('/').state,
      }),
    );
    expect(err.code).toBe('STATE_MISMATCH');
  });

  it('refuses a state that is the right length but the wrong value', async () => {
    // Same length matters: a length check alone would pass this, and a
    // constant-time compare only helps if it is actually reached.
    const { issuer, pending } = await started();
    const nearly = pending.state.slice(0, -1) + (pending.state.endsWith('A') ? 'B' : 'A');
    expect(nearly).toHaveLength(pending.state.length);
    expect((await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, { code: 'c', state: nearly }),
    )).code).toBe('STATE_MISMATCH');
  });

  it('exchanges NOTHING when state fails — the check comes first', async () => {
    // If the code were exchanged before state was checked, a forged callback
    // would burn a real authorization code at the issuer and hand us tokens we
    // then have to be careful with. The safest handling of an attacker's token
    // is never to have fetched it.
    const { issuer, pending } = await started();
    await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, { code: 'c', state: 'wrong' }),
    );
    expect(issuer.state.exchanges, 'a code was exchanged before state was checked')
      .toHaveLength(0);
  });

  it('refuses a REPLAYED callback, because the pending record is single-use', async () => {
    // The one that a `state` comparison cannot catch on its own: a replay
    // carries the CORRECT state by construction. What stops it is the pending
    // record being gone — the callback route clears the cookie before using it,
    // so the second arrival resolves `pending` to null.
    const { issuer, pending } = await started();

    const first = await completeSignIn(issuer.transport, testConfig(), pending, {
      code: 'authz-code-1',
      state: pending.state,
    });
    expect(first.subject).toBe('kc-aisha-0001');

    // Replay: identical query string, but the pending record has been consumed.
    const err = await refusal(
      completeSignIn(issuer.transport, testConfig(), null, {
        code: 'authz-code-1',
        state: pending.state,
      }),
    );
    expect(err.code).toBe('NO_PENDING_AUTHORIZATION');
    expect(issuer.state.exchanges, 'the replayed code was exchanged').toHaveLength(1);
  });

  it('refuses a callback that never started here at all', async () => {
    const { issuer } = await started();
    const err = await refusal(
      completeSignIn(issuer.transport, testConfig(), null, {
        code: 'attacker-code',
        state: 'attacker-state',
      }),
    );
    expect(err.code).toBe('NO_PENDING_AUTHORIZATION');
  });
});

describe('the pending sign-in ages out', () => {
  it('refuses a callback that arrives after the TTL', async () => {
    const { issuer, pending } = await started();
    const config = testConfig({ authorizationTtlSeconds: 600 });
    const err = await refusal(
      completeSignIn(
        issuer.transport, config, pending,
        { code: 'c', state: pending.state },
        pending.createdAt + 601,
      ),
    );
    expect(err.code).toBe('AUTHORIZATION_EXPIRED');
  });

  it('accepts one that arrives just inside it', async () => {
    const { issuer, pending } = await started();
    const done = await completeSignIn(
      issuer.transport, testConfig({ authorizationTtlSeconds: 600 }), pending,
      { code: 'c', state: pending.state },
      pending.createdAt + 600,
    );
    expect(done.subject).toBe('kc-aisha-0001');
  });
});

describe('PKCE reaches the token endpoint', () => {
  it('sends the verifier, and it is the pre-image of the challenge we sent', async () => {
    const issuer = syntheticIssuer({
      jwks,
      tokenFor: async () => ({ id_token: await mintIdToken({ key, nonce: pending.nonce }) }),
    });
    const config = testConfig();
    const { authorizationUrl, pending } = await startSignIn(issuer.transport, config, '/record');
    const challengeSent = new URL(authorizationUrl).searchParams.get('code_challenge')!;

    await completeSignIn(issuer.transport, config, pending, {
      code: 'authz-code-1',
      state: pending.state,
    });

    expect(issuer.state.exchanges).toHaveLength(1);
    const sent = issuer.state.exchanges[0]!;
    expect(sent.code).toBe('authz-code-1');
    expect(sent.redirectUri).toBe(config.redirectUri);
    // The property that makes PKCE work at all: the verifier redeemed at the
    // token endpoint hashes to the challenge sent at the authorization
    // endpoint. Computed independently of `challengeFor`.
    expect(expectedS256Challenge(sent.codeVerifier)).toBe(challengeSent);
  });
});

describe('the issuer said no, and other unhappy paths', () => {
  it('surfaces an authorization error without echoing the description', async () => {
    const { issuer, pending } = await started();
    const err = await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, {
        error: 'access_denied',
        errorDescription: '<img src=x onerror=alert(1)>',
        state: pending.state,
      }),
    );
    expect(err.code).toBe('AUTHORIZATION_DENIED');
    // The description is attacker-influenced text arriving in a query string.
    // It must not travel into anything we render.
    expect(err.message).not.toContain('onerror');
  });

  it('refuses a callback with a state but no code', async () => {
    const { issuer, pending } = await started();
    expect((await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, { state: pending.state }),
    )).code).toBe('NO_CODE');
  });

  it('refuses a token response with no ID token', async () => {
    const issuer = syntheticIssuer({ jwks, tokenFor: () => ({ access_token: 'a' }) });
    const { pending } = await startSignIn(issuer.transport, testConfig(), '/');
    expect((await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, { code: 'c', state: pending.state }),
    )).code).toBe('NO_ID_TOKEN');
  });

  it('refuses a REPLAYED ID token — the nonce belongs to an older sign-in', async () => {
    const { issuer, pending } = await started('nonce-from-a-token-captured-last-week');
    expect((await refusal(
      completeSignIn(issuer.transport, testConfig(), pending, { code: 'c', state: pending.state }),
    )).code).toBe('NONCE_MISMATCH');
  });

  it('lets a transport failure through as itself, not as a sign-in refusal', async () => {
    // Keycloak being down is an operational failure and must reach the alert
    // as one. Dressing it as an authentication refusal would show Aisha "your
    // sign-in was rejected" for an outage that is entirely ours.
    const { issuer, pending } = await started();
    issuer.state.failExchange = new Error('ECONNREFUSED');
    await expect(
      completeSignIn(issuer.transport, testConfig(), pending, { code: 'c', state: pending.state }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

describe('sign-out ends the session at the issuer', () => {
  it('builds an end-session URL carrying the client and the return address', () => {
    const url = endSessionUrl(
      `${ISSUER}/protocol/openid-connect/logout`,
      undefined,
      'https://northwind.thrive.app/signin/signed-out',
      CLIENT_ID,
    );
    const q = new URL(url!).searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('post_logout_redirect_uri'))
      .toBe('https://northwind.thrive.app/signin/signed-out');
  });

  it('returns null when the issuer publishes no end-session endpoint', () => {
    // Not an error and not a silent success. The caller must clear the local
    // cookie AND say plainly that the identity-provider session survives.
    expect(endSessionUrl(undefined, undefined, 'https://x.test/out', CLIENT_ID)).toBeNull();
  });
});

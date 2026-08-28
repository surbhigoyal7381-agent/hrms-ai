import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CODE_CHALLENGE_METHOD,
  beginAuthorization,
  challengeFor,
  createCodeVerifier,
  createNonce,
  createState,
  matchesOneTimeValue,
  safeReturnTo,
} from '../src/oidc/pkce.ts';
import { startSignIn } from '../src/oidc/flow.ts';
import {
  CLIENT_ID,
  REDIRECT_URI,
  expectedS256Challenge,
  jwksOf,
  makeKeypair,
  syntheticIssuer,
  testConfig,
} from './support/synthetic-issuer.ts';

/**
 * PKCE — SEC-01.
 *
 * The failure this file exists for: a flow downgraded to `code_challenge_method
 * = plain` works perfectly in a browser, passes every manual test, and provides
 * no protection at all, because the "proof" is sent in the clear on the first
 * request. Nothing about the screen changes.
 */

const key = await makeKeypair();
const jwks = await jwksOf(key);
const issuer = () => syntheticIssuer({ jwks, tokenFor: () => ({}) });

describe('the challenge is S256, computed the way the RFC says', () => {
  it('matches an independently computed SHA-256, not our own function', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    // The independent oracle. `expect(challengeFor(v)).toBe(challengeFor(v))`
    // passes whatever challengeFor does, including returning the verifier
    // unchanged — which is `plain`, which is the whole bug.
    expect(challengeFor(verifier)).toBe(expectedS256Challenge(verifier));

    // And the value is pinned, from RFC 7636's own worked example, so a change
    // of digest or encoding is caught even if both sides change together.
    expect(challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is NOT the verifier itself — the `plain` downgrade, named', () => {
    const verifier = createCodeVerifier();
    expect(challengeFor(verifier)).not.toBe(verifier);
    // A hash, not an encoding: base64url of 32 bytes is 43 characters.
    expect(challengeFor(verifier)).toHaveLength(43);
  });

  it('hashes the ASCII bytes of the verifier, which is what an issuer will do', () => {
    const verifier = createCodeVerifier();
    const independent = createHash('sha256')
      .update(Buffer.from(verifier, 'ascii'))
      .digest('base64url');
    expect(challengeFor(verifier)).toBe(independent);
  });
});

describe('the authorization request cannot ask for `plain`', () => {
  it('sends code_challenge_method=S256', async () => {
    const { transport } = issuer();
    const { authorizationUrl } = await startSignIn(transport, testConfig(), '/record');
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('sends a challenge that is the S256 of the verifier it kept', async () => {
    const { transport } = issuer();
    const { authorizationUrl, pending } = await startSignIn(transport, testConfig(), '/record');
    const sent = new URL(authorizationUrl).searchParams.get('code_challenge');

    // Independent oracle again: recompute from the RFC, not from challengeFor.
    expect(sent).toBe(expectedS256Challenge(pending.codeVerifier));
    expect(sent).not.toBe(pending.codeVerifier);
  });

  it('exports S256 as a constant with no `plain` alternative anywhere', () => {
    expect(CODE_CHALLENGE_METHOD).toBe('S256');
    // The type is a literal, so `plain` is not assignable. This asserts the
    // runtime half: there is no configuration switch to find.
    expect(Object.values({ CODE_CHALLENGE_METHOD })).not.toContain('plain');
  });

  it('carries state, nonce and the registered redirect_uri', async () => {
    const { transport } = issuer();
    const { authorizationUrl, pending } = await startSignIn(transport, testConfig(), '/record');
    const q = new URL(authorizationUrl).searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('nonce')).toBe(pending.nonce);
  });
});

describe('the three one-time values are three different values', () => {
  it('never reuses one for another', () => {
    const p = beginAuthorization('/record');
    expect(new Set([p.state, p.nonce, p.codeVerifier]).size).toBe(3);
  });

  it('produces fresh values every time', () => {
    // 200 draws: a generator that returned a constant, or seeded itself once at
    // module load, is caught here rather than in production six months later.
    const states = new Set(Array.from({ length: 200 }, () => createState()));
    const nonces = new Set(Array.from({ length: 200 }, () => createNonce()));
    expect(states.size).toBe(200);
    expect(nonces.size).toBe(200);
  });
});

describe('one-time values are compared without leaking their contents', () => {
  it('accepts an exact match and refuses everything else', () => {
    const value = createState();
    expect(matchesOneTimeValue(value, value)).toBe(true);
    expect(matchesOneTimeValue(value, value.slice(0, -1) + 'x')).toBe(false);
    expect(matchesOneTimeValue(value, value.slice(0, -1))).toBe(false);
    expect(matchesOneTimeValue(value, '')).toBe(false);
    expect(matchesOneTimeValue('', '')).toBe(false);
  });

  it('returns false on a length mismatch rather than throwing', () => {
    // `timingSafeEqual` throws on differing lengths, and a thrown error is
    // itself a signal — a caller could distinguish "wrong length" from "wrong
    // value" by whether it crashed.
    expect(() => matchesOneTimeValue('abc', 'abcdef')).not.toThrow();
    expect(matchesOneTimeValue('abc', 'abcdef')).toBe(false);
  });

  it('refuses non-strings instead of coercing them', () => {
    expect(matchesOneTimeValue(undefined as never, 'x')).toBe(false);
    expect(matchesOneTimeValue('x', null as never)).toBe(false);
  });
});

describe('returnTo cannot become an open redirect', () => {
  it('keeps ordinary same-site paths', () => {
    expect(safeReturnTo('/record')).toBe('/record');
    expect(safeReturnTo('/record?tab=history')).toBe('/record?tab=history');
  });

  it('refuses everything that leaves this site', () => {
    // Each of these renders as a link that genuinely starts on our domain,
    // which is what makes a credential-harvesting page believable.
    for (const hostile of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'http://evil.example',
      '/redirect?to=https://evil.example/x://',
      '/record\r\nSet-Cookie: a=b',
      'javascript:alert(1)',
      '',
    ]) {
      expect(safeReturnTo(hostile), `accepted ${JSON.stringify(hostile)}`).toBe('/');
    }
  });

  it('refuses a non-string without throwing', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo({ toString: () => '/record' })).toBe('/');
  });
});

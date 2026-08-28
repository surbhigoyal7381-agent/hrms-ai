import { describe, it, expect } from 'vitest';
import { decodeProtectedHeader } from 'jose';
import { verifyIdToken, IdTokenError, ACCEPTED_ALGORITHMS } from '../src/oidc/verify.ts';
import {
  CLIENT_ID,
  ISSUER,
  jwksOf,
  makeKeypair,
  mintAlgConfusionToken,
  mintAlgNoneToken,
  mintIdToken,
} from './support/synthetic-issuer.ts';

/**
 * ID token verification — SEC-01.
 *
 * This is the step most often stubbed to "decode and trust" during development
 * and never revisited, because a decoded token and a verified token are
 * identical in every log, every screen and every happy-path test. Only an
 * attacker can tell the difference.
 *
 * Every test here mints a token the attacker would mint and asserts we refuse
 * it. The positive control is the first block: if the honest token did not
 * verify, all the refusals below would be refusals of everything, and the file
 * would pass while proving nothing.
 */

const realKey = await makeKeypair('RS256', 'k1');
const attackerKey = await makeKeypair('RS256', 'k1'); // SAME kid, different key
const esKey = await makeKeypair('ES256', 'k-es');
const jwks = await jwksOf(realKey);

const NONCE = 'nonce-issued-for-this-signin';

const verify = (idToken: string, over: Partial<Parameters<typeof verifyIdToken>[0]> = {}) =>
  verifyIdToken({
    idToken,
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    expectedNonce: NONCE,
    ...over,
  });

async function refusal(promise: Promise<unknown>): Promise<IdTokenError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof IdTokenError) return err;
    throw err;
  }
  throw new Error('the token was ACCEPTED — expected a refusal');
}

describe('positive control: an honest token verifies', () => {
  it('accepts a correctly signed, correctly addressed, unexpired token', async () => {
    const token = await mintIdToken({ key: realKey, nonce: NONCE, subject: 'kc-aisha-0001' });
    const claims = await verify(token);
    expect(claims.sub).toBe('kc-aisha-0001');
    expect(claims.iss).toBe(ISSUER);
    expect(claims.nonce).toBe(NONCE);
  });
});

describe('the signature is actually checked', () => {
  it('refuses a token signed with a key the issuer does not publish', async () => {
    // The attacker's key carries the SAME `kid` as the real one. A verifier
    // that selects a key by kid and then does not check the signature — or one
    // that trusts a JWKS fetched from the token's own `jku` — accepts this.
    const token = await mintIdToken({ key: attackerKey, nonce: NONCE });
    expect(decodeProtectedHeader(token).kid).toBe('k1');
    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('refuses a token whose payload was edited after signing', async () => {
    const token = await mintIdToken({ key: realKey, nonce: NONCE, subject: 'kc-aisha-0001' });
    const [header, payload, signature] = token.split('.');
    const edited = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    edited.sub = 'kc-priya-chro';
    const forged = [
      header,
      Buffer.from(JSON.stringify(edited)).toString('base64url'),
      signature,
    ].join('.');

    // Independent oracle: prove the forgery really does say what we claim,
    // decoded WITHOUT the verifier. Otherwise "it was refused" might be
    // refusing a string that was never a plausible token.
    const decoded = JSON.parse(Buffer.from(forged.split('.')[1]!, 'base64url').toString());
    expect(decoded.sub).toBe('kc-priya-chro');

    expect((await refusal(verify(forged))).code).toBe('ID_TOKEN_INVALID');
  });

  it('refuses a token with an empty signature', async () => {
    const token = await mintIdToken({ key: realKey, nonce: NONCE });
    const [header, payload] = token.split('.');
    expect((await refusal(verify(`${header}.${payload}.`))).code).toBe('ID_TOKEN_INVALID');
  });
});

describe('the algorithm is ours to choose, never the token`s', () => {
  it('refuses `alg: none`', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintAlgNoneToken({
      sub: 'kc-aisha-0001',
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: now + 300,
      iat: now,
      nonce: NONCE,
    });

    // Independent oracle: the header really does say `none`, and the payload
    // really is otherwise perfect. This is a token that a header-trusting
    // verifier accepts and that produces a working sign-in as anybody.
    expect(decodeProtectedHeader(token).alg).toBe('none');

    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('refuses an algorithm outside the allowlist, even a strong one', async () => {
    // ES256 is a perfectly good algorithm and this token is genuinely signed.
    // It is refused because the key is not in the JWKS and the relying party
    // decides what it accepts. Algorithm confusion begins with "well, that one
    // is fine too".
    const token = await mintIdToken({ key: esKey, nonce: NONCE });
    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('refuses the algorithm-confusion token — HMAC signed with the public key', async () => {
    // The classic. `alg: HS256`, HMAC-signed with the issuer's own PUBLIC key
    // as the shared secret. A verifier that takes the algorithm from the header
    // and then fetches "the issuer's key" verifies this successfully with a key
    // anybody can download. It is refused here for one reason: the allowlist is
    // ours, and HS256 is not on it.
    const now = Math.floor(Date.now() / 1000);
    const token = await mintAlgConfusionToken(realKey, {
      sub: 'kc-aisha-0001',
      iss: ISSUER,
      aud: CLIENT_ID,
      exp: now + 300,
      iat: now,
      nonce: NONCE,
    });
    expect(decodeProtectedHeader(token).alg).toBe('HS256');
    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('publishes the allowlist as a frozen value, not a mutable default', () => {
    expect([...ACCEPTED_ALGORITHMS]).toEqual(['RS256', 'ES256']);
    expect(Object.isFrozen(ACCEPTED_ALGORITHMS)).toBe(true);
    expect([...ACCEPTED_ALGORITHMS]).not.toContain('none');
  });
});

describe('issuer, audience and expiry', () => {
  it('refuses a token from a different issuer', async () => {
    // Without this check, any identity provider in the world can authenticate
    // as our users — they only have to mint a token we will look at.
    const token = await mintIdToken({
      key: realKey,
      nonce: NONCE,
      issuer: 'https://issuer.test/realms/somebody-else',
    });
    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('refuses a token minted for a different application', async () => {
    // Same issuer, same realm, different client. The operator of that other
    // application could otherwise sign in here as any of its users.
    const token = await mintIdToken({ key: realKey, nonce: NONCE, audience: 'some-other-client' });
    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('accepts a token listing us among several audiences', async () => {
    const token = await mintIdToken({
      key: realKey,
      nonce: NONCE,
      audience: ['some-other-client', CLIENT_ID],
    });
    await expect(verify(token)).resolves.toBeDefined();
  });

  it('refuses an expired token', async () => {
    // The one that matters after a leak: a token copied out of a log last year
    // still works against a verifier that skips `exp`.
    const token = await mintIdToken({ key: realKey, nonce: NONCE, expiresInSeconds: -3600 });
    expect((await refusal(verify(token))).code).toBe('ID_TOKEN_INVALID');
  });

  it('refuses a token that expired just outside the clock tolerance', async () => {
    const token = await mintIdToken({ key: realKey, nonce: NONCE, expiresInSeconds: -31 });
    expect((await refusal(verify(token, { clockToleranceSeconds: 30 }))).code)
      .toBe('ID_TOKEN_INVALID');
  });

  it('tolerates a small clock skew, so a correct deployment does not flap', async () => {
    const token = await mintIdToken({ key: realKey, nonce: NONCE, expiresInSeconds: -5 });
    await expect(verify(token, { clockToleranceSeconds: 30 })).resolves.toBeDefined();
  });
});

describe('the nonce ties the token to THIS sign-in', () => {
  it('refuses a token carrying a different nonce', async () => {
    const token = await mintIdToken({ key: realKey, nonce: 'nonce-from-an-older-signin' });
    expect((await refusal(verify(token))).code).toBe('NONCE_MISMATCH');
  });

  it('refuses a token carrying no nonce at all', async () => {
    const token = await mintIdToken({ key: realKey });
    expect((await refusal(verify(token))).code).toBe('NONCE_MISMATCH');
  });

  it('refuses to verify when the CALLER forgot to carry the nonce through', async () => {
    // Checked before the signature, deliberately. A caller that lost the nonce
    // would otherwise get a token that verifies and a replay defence that is
    // silently absent — the flow would work, and nothing would say it stopped
    // being safe.
    const token = await mintIdToken({ key: realKey, nonce: NONCE });
    expect((await refusal(verify(token, { expectedNonce: '' }))).code).toBe('NONCE_NOT_ISSUED');
  });

  it('refuses an empty token string', async () => {
    expect((await refusal(verify(''))).code).toBe('ID_TOKEN_MISSING');
  });
});

describe('a valid signature is not a valid identity', () => {
  it('refuses a correctly signed token with no subject', async () => {
    const token = await mintIdToken({ key: realKey, nonce: NONCE, subject: '' });
    expect((await refusal(verify(token))).code).toMatch(/ID_TOKEN_NO_SUBJECT|ID_TOKEN_INVALID/);
  });
});

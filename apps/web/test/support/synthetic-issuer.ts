/**
 * A synthetic OpenID issuer — our own signing key, our own JWKS, our own
 * discovery document, and a token endpoint that behaves like a conforming
 * authorization server.
 *
 * WHY THIS AND NOT A REAL KEYCLOAK. Every attack this slice defends against —
 * `alg: none`, a token signed with the wrong key, a replayed `nonce`, a
 * mismatched `aud` — requires an issuer that will MISBEHAVE ON DEMAND. A real
 * Keycloak will not mint an `alg: none` token for you, so the tests that matter
 * most could not be written against it. Here they are three lines.
 *
 * WHAT IT THEREFORE DOES NOT PROVE, stated here rather than in a footnote,
 * because somebody will read a green suite as "sign-in works": it proves the
 * relying-party logic is correct against a conforming issuer AND refuses a
 * hostile one. It proves NOTHING about our Keycloak wiring — realm names,
 * client configuration, redirect-URI registration, whether discovery is
 * reachable from the container. That is a separate, later step.
 */
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet, type JWTPayload } from 'jose';
import { createHash } from 'node:crypto';
import type {
  ExchangeParams,
  OidcConfig,
  OidcEndpoints,
  OidcTransport,
  TokenResponse,
} from '../../src/oidc/config.ts';

export const ISSUER = 'https://issuer.test/realms/thrive';
export const CLIENT_ID = 'thrive-web';
export const REDIRECT_URI = 'https://northwind.thrive.app/signin/callback';

export function testConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'not-a-real-secret',
    redirectUri: REDIRECT_URI,
    authorizationTtlSeconds: 600,
    ...overrides,
  };
}

export interface Keypair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
  alg: string;
}

/**
 * `extractable: true` is required — `exportJWK` cannot publish a public key it
 * is not allowed to read, and a JWKS is the whole point of an issuer.
 */
export async function makeKeypair(alg = 'RS256', kid = 'k1'): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return { privateKey, publicKey, kid, alg };
}

export async function jwksOf(...keys: Keypair[]): Promise<JSONWebKeySet> {
  return {
    keys: await Promise.all(
      keys.map(async (k) => ({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: k.alg, use: 'sig' })),
    ),
  };
}

export interface MintOptions {
  key: Keypair;
  nonce?: string;
  subject?: string;
  issuer?: string;
  audience?: string | string[];
  /** Seconds from now. Negative mints an already-expired token. */
  expiresInSeconds?: number;
  issuedAtSeconds?: number;
  extraClaims?: JWTPayload;
}

/** Mints an ID token the way a conforming issuer would. */
export async function mintIdToken(opts: MintOptions): Promise<string> {
  const nowSeconds = opts.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ nonce: opts.nonce, ...opts.extraClaims })
    .setProtectedHeader({ alg: opts.key.alg, kid: opts.key.kid })
    .setSubject(opts.subject ?? 'kc-aisha-0001')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? CLIENT_ID)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + (opts.expiresInSeconds ?? 300));
  return jwt.sign(opts.key.privateKey);
}

/**
 * An `alg: none` token: header, payload, and an EMPTY signature.
 *
 * Built by hand rather than with `jose`, because `jose` will not produce one —
 * which is a point in its favour and a problem for a test that needs to prove
 * we refuse it. A verifier that reads the algorithm out of the token's own
 * header accepts this, and the sign-in that results looks completely normal.
 */
export function mintAlgNoneToken(claims: JWTPayload): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
}

/**
 * The algorithm-confusion token: HMAC-signed with the issuer's PUBLIC key as
 * the shared secret, declaring `alg: HS256`.
 *
 * This is the attack that killed a generation of JWT libraries. A verifier that
 * reads the algorithm out of the token and then looks up "the key" finds the
 * issuer's RSA public key, treats it as an HMAC secret because the header said
 * HS256, and verifies successfully — using a key that is, by definition,
 * public. Anybody can mint one.
 *
 * `jose` will not build this for us (it refuses an asymmetric key for a
 * symmetric algorithm), which is a point in its favour and the reason this is
 * assembled by hand.
 */
export async function mintAlgConfusionToken(
  key: Keypair,
  claims: JWTPayload,
): Promise<string> {
  const { createHmac, createPublicKey } = await import('node:crypto');
  const jwk = (await exportJWK(key.publicKey)) as import('node:crypto').JsonWebKey;
  const publicPem = createPublicKey({ key: jwk, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' })
    .toString();

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64({ alg: 'HS256', typ: 'JWT', kid: key.kid })}.${b64(claims)}`;
  const signature = createHmac('sha256', publicPem).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export interface IssuerState {
  /** Every exchange the flow performed, in order — so a test can assert PKCE. */
  exchanges: ExchangeParams[];
  /** Set to make the next exchange fail, the way a down issuer would. */
  failExchange?: Error;
}

export interface SyntheticIssuer {
  transport: OidcTransport;
  state: IssuerState;
  endpoints: OidcEndpoints;
}

export interface IssuerOptions {
  jwks: JSONWebKeySet;
  /** Called per exchange, so each test decides what token comes back. */
  tokenFor: (params: ExchangeParams) => Promise<TokenResponse> | TokenResponse;
  endpoints?: Partial<OidcEndpoints>;
}

/**
 * The transport a test hands to the flow. It stands in for the network, not for
 * the protocol: it records what was sent and returns what the test decides.
 */
export function syntheticIssuer(opts: IssuerOptions): SyntheticIssuer {
  const endpoints: OidcEndpoints = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    ...opts.endpoints,
  };
  const state: IssuerState = { exchanges: [] };

  return {
    endpoints,
    state,
    transport: {
      async discover() {
        return endpoints;
      },
      async jwks() {
        return opts.jwks;
      },
      async exchangeCode(params) {
        state.exchanges.push(params);
        if (state.failExchange) throw state.failExchange;
        return opts.tokenFor(params);
      },
    },
  };
}

/**
 * The S256 transformation, computed INDEPENDENTLY of `pkce.ts`.
 *
 * This is the independent oracle. Asserting `challenge === challengeFor(v)`
 * would compare the production code with itself and pass just as happily if
 * both sides were `plain`. Here the expected value comes from the RFC's
 * definition — BASE64URL(SHA256(ASCII(verifier))) — written out separately.
 */
export function expectedS256Challenge(verifier: string): string {
  return createHash('sha256').update(Buffer.from(verifier, 'ascii')).digest('base64url');
}

/**
 * OIDC configuration and the transport boundary.
 *
 * The flow logic in `flow.ts` talks to this interface, never to `fetch`. That
 * is what lets the whole flow — PKCE, state, nonce, signature, issuer,
 * audience, expiry, replay — be tested against a synthetic issuer whose keys we
 * control, without standing up an identity server.
 *
 * IT IS ALSO WHAT HAS NOT BEEN TESTED. Nothing here has been run against a real
 * Keycloak. The contract is implemented from the specification; the wiring is a
 * later, separate step. See the design note — "sign-in works" in this slice
 * means "the flow logic is correct against a conforming issuer", not "it works
 * against Keycloak".
 */
import type { JSONWebKeySet } from 'jose';

export interface OidcEndpoints {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** RP-initiated logout. Absent on issuers that do not support it. */
  end_session_endpoint?: string;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

export interface ExchangeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Everything the flow needs from the outside world. Four methods, no more. */
export interface OidcTransport {
  discover(): Promise<OidcEndpoints>;
  jwks(): Promise<JSONWebKeySet>;
  exchangeCode(params: ExchangeParams): Promise<TokenResponse>;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Seconds a pending sign-in stays valid before the callback is too late. */
  authorizationTtlSeconds: number;
}

export class OidcConfigError extends Error {}

/**
 * Reads configuration, or refuses to start.
 *
 * No defaults for the issuer, client id or secret. A default issuer would mean
 * a misconfigured deployment silently authenticating against the wrong identity
 * provider, which is indistinguishable from working until somebody signs in
 * with an account we do not control.
 */
export function loadOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new OidcConfigError(`${name} is not set. See .env.example.`);
    }
    return value.trim();
  };

  const issuer = required('OIDC_ISSUER');
  // http is fine only for a loopback development issuer; anywhere else it means
  // the ID token and the authorization code cross the network in the clear.
  if (!/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(issuer)) {
    throw new OidcConfigError(`OIDC_ISSUER must be https (got ${issuer}).`);
  }

  const ttl = Number(env.OIDC_AUTHORIZATION_TTL_SECONDS ?? 600);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 3600) {
    throw new OidcConfigError('OIDC_AUTHORIZATION_TTL_SECONDS must be 1..3600.');
  }

  return {
    issuer,
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    redirectUri: required('OIDC_REDIRECT_URI'),
    authorizationTtlSeconds: ttl,
  };
}

/**
 * The real transport. Not exercised by any test in this slice — see the note at
 * the top of this file.
 */
export function httpTransport(config: OidcConfig): OidcTransport {
  let cached: OidcEndpoints | null = null;

  const discover = async (): Promise<OidcEndpoints> => {
    if (cached) return cached;
    const url = `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new OidcConfigError(`Discovery failed: ${res.status}`);
    const doc = (await res.json()) as OidcEndpoints;
    // The discovery document is fetched from the issuer, but it still states an
    // issuer of its own, and they must agree — otherwise a redirected or
    // cached document could point us at somebody else's endpoints.
    if (doc.issuer !== config.issuer) {
      throw new OidcConfigError(
        `Discovery issuer mismatch: expected ${config.issuer}, got ${doc.issuer}`,
      );
    }
    cached = doc;
    return doc;
  };

  return {
    discover,
    async jwks() {
      const { jwks_uri } = await discover();
      const res = await fetch(jwks_uri, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new OidcConfigError(`JWKS fetch failed: ${res.status}`);
      return (await res.json()) as JSONWebKeySet;
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const { token_endpoint } = await discover();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      });
      const res = await fetch(token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          // Client secret in the header, not the body: bodies end up in logs.
          authorization:
            'Basic ' +
            Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64'),
        },
        body,
      });
      if (!res.ok) throw new OidcConfigError(`Token exchange failed: ${res.status}`);
      return (await res.json()) as TokenResponse;
    },
  };
}

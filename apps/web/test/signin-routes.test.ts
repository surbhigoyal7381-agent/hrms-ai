import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverRoutes } from '../src/route-manifest.ts';
import {
  readCookie,
  serialiseCookie,
  signinSlugFromHost,
} from '../src/oidc/runtime.ts';
import { PENDING_COOKIE_NAME, clearedPendingCookie, pendingCookieOptions } from '../src/oidc/pending-cookie.ts';

/**
 * The sign-in surface — REQ-022, REQ-031, SEC-01.
 *
 * The route descriptors are read from the SAME filesystem walk the boot check
 * uses, never from a list written here. A route added tomorrow appears in this
 * test on the day it is added, which is the property feature 001's hand-written
 * `TENANT_SCOPED` list did not have.
 */

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..', 'app');

describe('the sign-in routes declare who may reach them', () => {
  it('all three exist and are all `public`, gated by nothing, post-exit false', async () => {
    const routes = await discoverRoutes(APP_DIR);
    const byPath = new Map(routes.map((r) => [r.path, r]));

    for (const path of ['/signin/start', '/signin/callback', '/signin/out']) {
      const route = byPath.get(path);
      expect(route, `${path} was not found by the walk`).toBeDefined();
      // `public` is correct and is the only correct answer: these are the
      // routes somebody reaches when they are not yet anybody.
      expect(route!.access, `${path} declared nothing`).toEqual({
        auth: 'public',
        tenantSettingGated: false,
        postExit: false,
      });
    }
  });

  it('adds no new post-exit surface — REQ-022 still grants exactly three', async () => {
    // REQ-022's allowlist is three routes. Sign-in is `public`, so it is
    // reachable by everybody including an ex-employee inside the window, and
    // marking it `postExit: true` would claim a grant it does not need and
    // widen a list the requirement caps.
    const routes = await discoverRoutes(APP_DIR);
    expect(routes.filter((r) => r.access?.postExit).map((r) => r.path)).toEqual([]);
  });
});

describe('the tenant label out of the request host', () => {
  it('takes the first label of a tenant address', () => {
    expect(signinSlugFromHost('northwind.thrive.app')).toBe('northwind');
    expect(signinSlugFromHost('northwind-trading-co.thrive.app')).toBe('northwind-trading-co');
  });

  it('folds case and strips the port', () => {
    expect(signinSlugFromHost('NorthWind.Thrive.App:3000')).toBe('northwind');
  });

  it('refuses a host that names no organisation', () => {
    // Each of these would otherwise reach the database as a query argument. It
    // is parameterised either way; refusing here means a hostile `Host` header
    // never gets that far.
    for (const host of [
      'localhost',
      'thriveapp',
      '',
      '.thrive.app',
      'north_wind.thrive.app',
      '-northwind.thrive.app',
      'northwind-.thrive.app',
      'ab.thrive.app',
      "north'wind.thrive.app",
      'x'.repeat(70) + '.thrive.app',
    ]) {
      expect(signinSlugFromHost(host), `accepted ${JSON.stringify(host)}`).toBeNull();
    }
    expect(signinSlugFromHost(null)).toBeNull();
    expect(signinSlugFromHost(undefined)).toBeNull();
  });
});

describe('cookies on the wire', () => {
  it('reads one cookie out of a header holding several', () => {
    const request = new Request('https://northwind.thrive.app/signin/callback', {
      headers: { cookie: `other=1; ${PENDING_COOKIE_NAME}=abc%3Ddef; hrms_session=xyz` },
    });
    expect(readCookie(request, PENDING_COOKIE_NAME)).toBe('abc=def');
    expect(readCookie(request, 'hrms_session')).toBe('xyz');
    expect(readCookie(request, 'not-there')).toBeUndefined();
  });

  it('does not confuse a cookie whose name is a suffix of another', () => {
    const request = new Request('https://northwind.thrive.app/', {
      headers: { cookie: 'not_hrms_session=wrong; hrms_session=right' },
    });
    expect(readCookie(request, 'hrms_session')).toBe('right');
  });

  it('returns undefined when there is no cookie header at all', () => {
    const request = new Request('https://northwind.thrive.app/');
    expect(readCookie(request, 'hrms_session')).toBeUndefined();
  });

  it('serialises the security attributes that make the cookie safe', () => {
    const header = serialiseCookie({
      name: PENDING_COOKIE_NAME,
      value: 'sealed-value',
      options: pendingCookieOptions(),
    });
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=600');
  });

  it('clears a cookie with both Max-Age=0 and an Expires in the past', () => {
    // `Max-Age` alone is ignored by some older clients. A sign-out that clears
    // the cookie on most browsers is not a sign-out.
    const header = serialiseCookie({ name: PENDING_COOKIE_NAME, ...clearedPendingCookie() });
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('percent-encodes a value so it cannot inject a second attribute', () => {
    const header = serialiseCookie({
      name: 'x',
      value: 'a; Domain=evil.example',
      options: pendingCookieOptions(),
    });
    expect(header).not.toContain('Domain=evil.example');
    expect(header.split(';')[0]).toBe('x=a%3B%20Domain%3Devil.example');
  });
});

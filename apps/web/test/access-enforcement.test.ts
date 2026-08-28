import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access as fsAccess } from 'node:fs/promises';
import {
  decideRouteAccess,
  POST_EXIT_ALLOWED_PATHS,
  type AccessDecision,
  type AccessPrincipal,
  type AuthRequirement,
  type RouteAccess,
  type SettingState,
} from '@hrms/core';
import { discoverRoutes } from '../src/route-manifest.ts';

/**
 * REQ-001, REQ-016, REQ-022, SEC-01 — the descriptors, applied.
 *
 * The list of routes under test is produced by WALKING THE SAME DIRECTORY
 * Next.js serves. There is no array of paths in this file. That is the whole
 * design, and it is the direct lesson of feature 001's `TENANT_SCOPED` list,
 * which was written by hand, omitted the one table that mattered, and survived
 * 28 passing tests twice. A route added in feature 004 appears in every
 * assertion below on the day the file lands, whether or not anybody remembered
 * this test existed.
 *
 * Two things are being proved, and they are different:
 *
 *   COVERAGE   — no route on disk escapes the gate. Enumerated from the walk.
 *   BEHAVIOUR  — the gate decides correctly for every shape a descriptor can
 *                take. Enumerated from the descriptor type itself, because the
 *                app does not yet contain one route of every shape, and a
 *                property asserted only over shapes that exist today is a
 *                property that stops being asserted the day one is removed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..', 'app');

// ---------------------------------------------------------------------------
// Personas. Named after the people in CLAUDE.md, because "principal A" tells a
// reviewer nothing about whether the case matters.
// ---------------------------------------------------------------------------

const principal = (
  lifecycle: AccessPrincipal['lifecycle'],
  roles: AccessPrincipal['roles'] = new Set(),
): AccessPrincipal => ({ personId: 'p-1', tenantId: 't-1', lifecycle, roles });

const PERSONAS: ReadonlyArray<{ name: string; principal: AccessPrincipal | null }> = [
  // Not signed in — and, identically, signed in with a cookie we cannot open,
  // or with a subject that has no live identity link. All three are "we do not
  // know who this is", which is one case, not three.
  { name: 'anonymous', principal: null },
  { name: 'Aisha, employed', principal: principal('employed') },
  { name: 'Aisha, hired but not started', principal: principal('pre_hire') },
  { name: 'Aisha, left the company', principal: principal('exited') },
  { name: 'Rohan, manager', principal: principal('employed', new Set(['manager'])) },
  { name: 'Meera, HR admin', principal: principal('employed', new Set(['hr_admin'])) },
  { name: 'Dev, IT admin', principal: principal('employed', new Set(['it_admin'])) },
  { name: 'a person with no employment', principal: principal('no_employment') },
];

const AUTHENTICATED = PERSONAS.filter((p) => p.principal !== null);

// ---------------------------------------------------------------------------
// Setting states. Four, not three: `unreadable` is the one the human ruled on.
// ---------------------------------------------------------------------------

const SETTING: Record<string, SettingState> = {
  on: { kind: 'resolved', enabled: true, source: 'stored' },
  off: { kind: 'resolved', enabled: false, source: 'stored' },
  unset: { kind: 'resolved', enabled: false, source: 'unset' },
  unreadable: { kind: 'unreadable' },
};

const STORED_STATES = ['on', 'off', 'unset'] as const;
const ALL_STATES = ['on', 'off', 'unset', 'unreadable'] as const;

const routesOnDisk = async () => {
  const routes = await discoverRoutes(APP_DIR);
  return routes.map((r) => ({ path: r.path, file: r.file, access: r.access! }));
};

describe('the enumeration is real, before anything is asserted over it', () => {
  it('finds files that fs agrees are on disk', async () => {
    // The independent oracle. "For every route ..." over an empty list passes
    // every property in this file and proves nothing at all — which is exactly
    // how feature 001 shipped a green suite over a list that had lost its most
    // important entry.
    for (const file of [
      'api/health/route.ts',
      'signin/start/route.ts',
      'signin/callback/route.ts',
      'signin/out/route.ts',
    ]) {
      await expect(
        fsAccess(resolve(APP_DIR, file)),
        `${file} is not on disk — this test is checking the wrong directory`,
      ).resolves.toBeUndefined();
    }

    const routes = await routesOnDisk();
    expect(routes.length).toBeGreaterThanOrEqual(4);
    // Every route declared something, or the boot check would have refused to
    // start and the assertions below would be reading `undefined`.
    expect(routes.every((r) => r.access !== undefined)).toBe(true);
  });

  it('crosses enough combinations to be worth calling a matrix', async () => {
    const routes = await routesOnDisk();
    expect(PERSONAS.length).toBeGreaterThanOrEqual(8);
    expect(routes.length * PERSONAS.length * ALL_STATES.length).toBeGreaterThanOrEqual(100);
  });

  it('contains at least one route of each kind the properties below assert over', () => {
    // NON-VACUITY, and it is the most important assertion in this file.
    //
    // "For every setting-gated route, off and unset are identical" is TRUE and
    // WORTHLESS in an app with no setting-gated route. Until `/api/me/record`
    // landed, that is exactly what it was. This fails the day somebody deletes
    // the last gated route, or the last route needing a session, rather than
    // letting the suite go quietly green over nothing.
    return routesOnDisk().then((routes) => {
      expect(
        routes.filter((r) => r.access.tenantSettingGated).length,
        'no setting-gated route on disk — every REQ-001 property below is vacuous',
      ).toBeGreaterThan(0);
      expect(
        routes.filter((r) => r.access.auth !== 'public').length,
        'no authenticated route on disk — the 401 properties below are vacuous',
      ).toBeGreaterThan(0);
      expect(
        routes.filter((r) => r.access.auth === 'public').length,
        'no public route on disk — the carve-out properties below are vacuous',
      ).toBeGreaterThan(0);
    });
  });
});

describe('every route on disk, every persona, every setting state', () => {
  it('refuses an unauthenticated caller on every non-public route', async () => {
    const routes = await routesOnDisk();
    const nonPublic = routes.filter((r) => r.access.auth !== 'public');

    for (const route of nonPublic) {
      // `unreadable` is excluded: it denies earlier, with 503, because a broken
      // store is a statement about us and outranks a statement about the caller.
      for (const state of STORED_STATES) {
        const decision = decideRouteAccess({
          access: route.access,
          principal: null,
          setting: SETTING[state]!,
        });
        expect(decision.allowed, `${route.path} served an anonymous caller`).toBe(false);
        expect(decision, `${route.path} (${state})`).toMatchObject({
          status: 401,
          code: 'AUTHENTICATION_REQUIRED',
        });
      }
    }
  });

  it('refuses a setting-gated route IDENTICALLY when off and when unset', async () => {
    // REQ-001. An employee who could tell "my employer deliberately switched
    // this off" from "nobody has ever configured it" would be reading an
    // administrative fact about their employer out of an error response.
    // Deep equality, not "both are 403" — the status, the code and every other
    // field must match, so `source` cannot leak through some future addition.
    const routes = await routesOnDisk();
    const gated = routes.filter((r) => r.access.tenantSettingGated);

    for (const route of gated) {
      for (const persona of AUTHENTICATED) {
        const off = decideRouteAccess({
          access: route.access, principal: persona.principal, setting: SETTING.off!,
        });
        const unset = decideRouteAccess({
          access: route.access, principal: persona.principal, setting: SETTING.unset!,
        });
        expect(unset, `${route.path} / ${persona.name}: unset differs from off`).toEqual(off);
        expect(off.allowed, `${route.path} / ${persona.name}: served with the setting off`)
          .toBe(false);
      }
    }
  });

  it('answers 503 and never 403 when the setting store is unreachable', async () => {
    // The human-approved RULE-001 divergence, 2026-08-28. A 403 renders "your
    // organisation has not turned this on" — a false sentence about the
    // employer's choice when the truth is that we are broken.
    const routes = await routesOnDisk();
    const gated = routes.filter((r) => r.access.tenantSettingGated);

    for (const route of gated) {
      for (const persona of AUTHENTICATED) {
        const decision = decideRouteAccess({
          access: route.access, principal: persona.principal, setting: SETTING.unreadable!,
        });
        expect(decision.allowed, `${route.path}: served on an unreadable setting`).toBe(false);
        if (decision.allowed) continue;
        // Post-exit is refused before the setting is consulted, and that is
        // correct — the window is narrower than the switch. Every other
        // authenticated persona must get the 503.
        if (decision.code === 'POST_EXIT_SESSION') continue;
        expect(decision.code, `${route.path} / ${persona.name} got a 403 for OUR outage`)
          .toBe('TEMPORARILY_UNAVAILABLE');
        expect(decision.status).toBe(503);
      }
    }
  });

  it('leaves an UNGATED route unaffected by the setting, in all four states', async () => {
    // The over-correction this catches: a gate applied to everything. The
    // carve-out — the export and the data-protection contact — must keep
    // working when the switch is off, because a tenant setting never governs a
    // statutory right (RULE-002).
    const routes = await routesOnDisk();
    // Public AND ungated. A route that needs a session still needs the
    // per-request lookup, so an unreadable store denies it with 503 — correctly,
    // and that is asserted separately below. The property here is narrower and
    // is the one that matters for RULE-002: a route the switch does not govern
    // is not governed by the switch.
    const ungated = routes.filter(
      (r) => !r.access.tenantSettingGated && r.access.auth === 'public',
    );
    expect(ungated.length).toBeGreaterThan(0);

    for (const route of ungated) {
      for (const persona of PERSONAS) {
        const decisions = ALL_STATES.map((state) =>
          decideRouteAccess({
            access: route.access, principal: persona.principal, setting: SETTING[state]!,
          }),
        );
        for (const d of decisions) {
          expect(d, `${route.path} / ${persona.name} varied with the setting`)
            .toEqual(decisions[0]);
        }
      }
    }
  });

  it('lets ONLY the three allowlisted paths be reached after exit', async () => {
    // REQ-022's cap, asserted against the requirement written down rather than
    // against the implementation. A fourth reachable route fails here on the
    // day it is added.
    const routes = await routesOnDisk();
    const exited = principal('exited');

    const reachable: string[] = [];
    for (const route of routes) {
      for (const state of STORED_STATES) {
        const decision = decideRouteAccess({
          access: route.access, principal: exited, setting: SETTING[state]!,
        });
        if (decision.allowed) reachable.push(route.path);
      }
    }

    for (const path of new Set(reachable)) {
      expect(
        POST_EXIT_ALLOWED_PATHS.includes(path),
        `${path} is reachable after exit and REQ-022 does not grant it`,
      ).toBe(true);
    }
  });

  it('never lets an employee reach an hr_admin route', async () => {
    const routes = await routesOnDisk();
    const adminOnly = routes.filter((r) => r.access.auth === 'hr_admin');

    for (const route of adminOnly) {
      for (const persona of AUTHENTICATED.filter((p) => !p.principal!.roles.has('hr_admin'))) {
        for (const state of ALL_STATES) {
          const decision = decideRouteAccess({
            access: route.access, principal: persona.principal, setting: SETTING[state]!,
          });
          expect(decision.allowed, `${route.path} served ${persona.name}`).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// BEHAVIOUR, enumerated from the descriptor type rather than from the app.
//
// The app does not yet contain a route of every shape. A property asserted only
// over the shapes that happen to exist today silently stops being asserted the
// day one is deleted — which is a slower version of the same failure the walk
// above exists to prevent. So every combination the type permits is built here
// and decided.
// ---------------------------------------------------------------------------

const AUTHS: readonly AuthRequirement[] = ['public', 'employee', 'hr_admin'];

const everyDescriptor = (): RouteAccess[] => {
  const out: RouteAccess[] = [];
  for (const auth of AUTHS) {
    for (const tenantSettingGated of [true, false]) {
      for (const postExit of [true, false]) {
        out.push({ auth, tenantSettingGated, postExit });
      }
    }
  }
  return out;
};

describe('every descriptor shape the type permits', () => {
  it('builds all twelve, so nothing below is vacuous', () => {
    expect(everyDescriptor()).toHaveLength(12);
  });

  it('denies EVERY shape when the descriptor is missing at request time', () => {
    // The gap this whole file exists to close. The boot check is the first line
    // of defence and not the only one: a manifest that failed to build, a path
    // that resolved to no entry, a route added to a running process. We do not
    // know who may reach it, and the answer to that is never "allow".
    for (const persona of PERSONAS) {
      for (const state of ALL_STATES) {
        const decision = decideRouteAccess({
          access: undefined,
          principal: persona.principal,
          setting: SETTING[state]!,
        });
        expect(decision.allowed, `an undeclared route served ${persona.name}`).toBe(false);
        expect(decision).toMatchObject({ status: 403, code: 'ROUTE_NOT_DECLARED' });
        // It alerts. Reaching this line means the boot check was walked around,
        // which is an incident rather than a 403 to shrug at.
        if (!decision.allowed) expect(decision.alert).not.toBeNull();
      }
    }
  });

  it('refuses every non-public shape to an anonymous caller', () => {
    for (const access of everyDescriptor().filter((a) => a.auth !== 'public')) {
      for (const state of STORED_STATES) {
        const d = decideRouteAccess({ access, principal: null, setting: SETTING[state]! });
        expect(d, JSON.stringify(access)).toMatchObject({
          allowed: false, status: 401, code: 'AUTHENTICATION_REQUIRED',
        });
      }
    }
  });

  it('applies the gate to every gated shape and to no ungated one', () => {
    // Both halves in one test, deliberately: "the gate blocks" and "the gate is
    // scoped" are the two ways this can be wrong, and testing only the first
    // passes a gate welded shut across the whole product.
    const employed = principal('employed');

    for (const access of everyDescriptor().filter((a) => a.auth !== 'hr_admin')) {
      const off = decideRouteAccess({ access, principal: employed, setting: SETTING.off! });
      const on = decideRouteAccess({ access, principal: employed, setting: SETTING.on! });

      if (access.tenantSettingGated) {
        expect(off, JSON.stringify(access)).toMatchObject({
          allowed: false, status: 403, code: 'RECORD_VIEW_DISABLED',
        });
        expect(on.allowed, JSON.stringify(access)).toBe(true);
      } else {
        expect(off.allowed, `ungated route blocked by the setting: ${JSON.stringify(access)}`)
          .toBe(true);
        expect(on.allowed).toBe(true);
      }
    }
  });

  it('treats off and unset as one refusal for every gated shape', () => {
    const employed = principal('employed');
    for (const access of everyDescriptor().filter((a) => a.tenantSettingGated)) {
      const off = decideRouteAccess({ access, principal: employed, setting: SETTING.off! });
      const unset = decideRouteAccess({ access, principal: employed, setting: SETTING.unset! });
      expect(unset, JSON.stringify(access)).toEqual(off);
    }
  });

  it('turns an unreadable store into 503 for every gated shape', () => {
    const employed = principal('employed');
    // `hr_admin` shapes are excluded because the role gate refuses them first,
    // and that ordering is correct: a caller who may not reach the route at all
    // must not learn the state of the organisation's setting from trying.
    for (const access of everyDescriptor()
      .filter((a) => a.tenantSettingGated && a.auth !== 'hr_admin')) {
      const d = decideRouteAccess({ access, principal: employed, setting: SETTING.unreadable! });
      expect(d, JSON.stringify(access)).toMatchObject({
        allowed: false, status: 503, code: 'TEMPORARILY_UNAVAILABLE',
      });
      if (!d.allowed) expect(d.alert).not.toBeNull();
    }
  });

  it('refuses an exited caller on every shape that does not declare postExit', () => {
    const exited = principal('exited');
    for (const access of everyDescriptor().filter((a) => !a.postExit && a.auth !== 'hr_admin')) {
      for (const state of STORED_STATES) {
        const d = decideRouteAccess({ access, principal: exited, setting: SETTING[state]! });
        expect(d, JSON.stringify(access)).toMatchObject({
          allowed: false, status: 403, code: 'POST_EXIT_SESSION',
        });
      }
    }
  });

  it('refuses an exited caller EVEN WHEN the tenant setting is ON', () => {
    // REQ-022 in as many words: the window is narrower than the switch, never
    // wider. The natural implementation — check the setting, then let anyone
    // authenticated through — gets this backwards.
    const access: RouteAccess = { auth: 'employee', tenantSettingGated: true, postExit: false };
    const d = decideRouteAccess({
      access, principal: principal('exited'), setting: SETTING.on!,
    });
    expect(d).toMatchObject({ allowed: false, code: 'POST_EXIT_SESSION' });
  });

  it('lets a pre-hire and a no-employment caller through the lifecycle gate', () => {
    // REQ-002's edge case: somebody hired but not started may still read their
    // own record. Only `exited` is a lifecycle refusal, and asserting that
    // explicitly stops a future "if (lifecycle !== 'employed') deny" from
    // looking like a tightening.
    for (const lifecycle of ['pre_hire', 'no_employment'] as const) {
      const d = decideRouteAccess({
        access: { auth: 'employee', tenantSettingGated: true, postExit: false },
        principal: principal(lifecycle),
        setting: SETTING.on!,
      });
      expect(d.allowed, lifecycle).toBe(true);
    }
  });

  it('denies every hr_admin shape while roles are not resolved from the database', () => {
    // Nothing in this product resolves roles yet. `AccessPrincipal.roles` is
    // empty on every real request, so an hr_admin route denies EVERYBODY — and
    // that is the intended behaviour until role resolution ships. Written down
    // as a test so the first admin route to be built fails loudly on its first
    // run rather than quietly serving nobody in production.
    for (const access of everyDescriptor().filter((a) => a.auth === 'hr_admin')) {
      const d = decideRouteAccess({
        access, principal: principal('employed'), setting: SETTING.on!,
      });
      expect(d, JSON.stringify(access)).toMatchObject({ allowed: false, code: 'FORBIDDEN' });
    }
    // Positive control: with the role present, the same shape is allowed —
    // otherwise the assertion above is satisfied by a function that denies
    // everything.
    const withRole = decideRouteAccess({
      access: { auth: 'hr_admin', tenantSettingGated: false, postExit: false },
      principal: principal('employed', new Set(['hr_admin'])),
      setting: SETTING.on!,
    });
    expect(withRole.allowed).toBe(true);
  });

  it('never leaks the setting source into a refusal', () => {
    // `source` distinguishes "off" from "unset" and is needed for the log. If
    // it ever reaches the wire, REQ-001's indistinguishability is gone. This
    // asserts on the serialised decision, so a field added later is caught.
    const employed = principal('employed');
    for (const state of ['off', 'unset'] as const) {
      const d: AccessDecision = decideRouteAccess({
        access: { auth: 'employee', tenantSettingGated: true, postExit: false },
        principal: employed,
        setting: SETTING[state]!,
      });
      expect(JSON.stringify(d)).not.toContain('unset');
      expect(JSON.stringify(d)).not.toContain('stored');
    }
  });
});

describe('a broken store is a statement about us, not about the caller', () => {
  it('answers 503 on every shape that needed the lookup, gated or not', () => {
    // The per-request resolution is ONE query answering both "who is this" and
    // "what does the setting say". When it fails, an authenticated route cannot
    // reply 401 — that would send Aisha to reset a password that was never
    // wrong. It covers the ungated-but-authenticated shapes too, which is where
    // the export and the data-protection contact will live.
    for (const access of everyDescriptor().filter(
      (a) => a.auth !== 'public' || a.tenantSettingGated,
    )) {
      for (const persona of PERSONAS) {
        const d = decideRouteAccess({
          access, principal: persona.principal, setting: SETTING.unreadable!,
        });
        expect(d, `${JSON.stringify(access)} / ${persona.name}`).toMatchObject({
          allowed: false, status: 503, code: 'TEMPORARILY_UNAVAILABLE',
        });
      }
    }
  });

  it('leaves a public, ungated route working while the database is down', () => {
    // A liveness probe that fails when the database is down reports the wrong
    // outage, and a sign-in redirect that 503s when one tenant's row is
    // unreadable takes down sign-in for everybody.
    const access: RouteAccess = { auth: 'public', tenantSettingGated: false, postExit: false };
    const d = decideRouteAccess({ access, principal: null, setting: SETTING.unreadable! });
    expect(d.allowed).toBe(true);
  });

  it('alerts on the 503 — an outage must page somebody, not just answer politely', () => {
    const d = decideRouteAccess({
      access: { auth: 'employee', tenantSettingGated: true, postExit: false },
      principal: null,
      setting: SETTING.unreadable!,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.alert).not.toBeNull();
  });
});

describe('no route can skip the gate', () => {
  /**
   * The hole this closes. `decideRouteAccess` can be perfect and every
   * descriptor correct, and a route that simply does not call the guard serves
   * anybody. Grepping for `guarded(` would prove the text is present; this
   * proves the EXPORTED HANDLER is the wrapped one, which is the thing requests
   * actually reach.
   */
  it('every HTTP handler on disk is a guarded handler, declaring its own path', async () => {
    const { pathToFileURL } = await import('node:url');
    const { join } = await import('node:path');

    const routes = (await discoverRoutes(APP_DIR)).filter((r) =>
      r.file.endsWith('route.ts') || r.file.endsWith('route.tsx'),
    );
    expect(routes.length, 'no route files found — wrong directory').toBeGreaterThanOrEqual(4);

    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
    let handlersChecked = 0;

    for (const route of routes) {
      const absolute = join(APP_DIR, route.file.replace(/^app[\\/]/, ''));
      const mod = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;

      const exported = METHODS.filter((m) => typeof mod[m] === 'function');
      expect(exported.length, `${route.path} exports no HTTP handler`).toBeGreaterThan(0);

      for (const method of exported) {
        const handler = mod[method] as { name?: string; declaredPath?: string };
        expect(
          handler.name,
          `${method} ${route.path} is not wrapped in guarded() — it gates nothing`,
        ).toBe('guardedRoute');
        expect(
          handler.declaredPath,
          `${method} ${route.path} declared the wrong path to the guard`,
        ).toBe(route.path);
        handlersChecked += 1;
      }
    }

    // Non-vacuity: "every handler is guarded" over zero handlers is true and
    // useless. This is the assertion that would have caught feature 001's
    // `TENANT_SCOPED` list, which was also true over the wrong set.
    expect(handlersChecked).toBeGreaterThanOrEqual(4);
  });

  it('every declared path resolves to a descriptor in the manifest', async () => {
    // A handler that declares a path the manifest does not contain would be
    // denied on every request with ROUTE_NOT_DECLARED — fail-closed, but as an
    // outage rather than a deployment error. Caught here instead.
    const { routeManifest } = await import('../src/guard.ts');
    const manifest = await routeManifest();
    const routes = await routesOnDisk();

    expect(manifest.size).toBe(routes.length);
    for (const route of routes) {
      expect(manifest.get(route.path), `${route.path} is missing from the manifest`)
        .toEqual(route.access);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access as fsAccess } from 'node:fs/promises';
import { assertRouteManifest, RouteManifestError } from '@hrms/core/route-access';
import { discoverRoutes, urlPathFor } from '../src/route-manifest.ts';

/**
 * REQ-001 / REQ-022 — the route manifest.
 *
 * The property under test is not "the manifest is correct". It is that a route
 * which exists on disk CANNOT escape the check, because the list is produced by
 * walking the same directory Next.js serves rather than maintained by hand.
 * Feature 001's `TENANT_SCOPED` list is the reason: it omitted one table and 28
 * passing tests never saw it, twice.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, 'fixtures', name);
const APP_DIR = resolve(here, '..', 'app');

describe('the walk finds what is on disk', () => {
  it('finds the real health route, which exists independently of the walk', async () => {
    // Independent oracle: assert the FILE is there, using fs directly, before
    // asking the walk about it. Otherwise "the walk found one route" could be
    // satisfied by a walk that invents one, and "found none" by a walk pointed
    // at the wrong directory.
    await expect(fsAccess(resolve(APP_DIR, 'api', 'health', 'route.ts')))
      .resolves.toBeUndefined();

    const routes = await discoverRoutes(APP_DIR);
    const health = routes.find((r) => r.path === '/api/health');

    expect(health, 'the walk did not find a route that is on disk').toBeDefined();
    expect(health!.access).toEqual({
      auth: 'public', tenantSettingGated: false, postExit: false,
    });
  });

  it('reports a route that declares nothing, rather than skipping it', async () => {
    // The failure mode that matters. A walk that silently ignored undeclared
    // files would produce a clean manifest and an unguarded endpoint.
    const routes = await discoverRoutes(fixture('missing'));
    expect(routes).toHaveLength(1);
    expect(routes[0]!.path).toBe('/api/thing');
    expect(routes[0]!.access, 'an undeclared route was not reported as undeclared')
      .toBeUndefined();
  });

  it('strips route groups from the URL, so allowlist paths can match', async () => {
    // `app/(employee)/record/page.tsx` serves `/record`. Leaving the group in
    // would give `/(employee)/record`, which never matches POST_EXIT_ALLOWED_PATHS
    // — the allowlist would silently never apply.
    expect(urlPathFor(`api${'/'}health${'/'}route.ts`)).toBe('/api/health');
    const routes = await discoverRoutes(fixture('groups'));
    expect(routes.map((r) => r.path)).toEqual(['/record']);
  });
});

describe('assertRouteManifest — what makes the boot fail', () => {
  it('accepts the real application manifest', async () => {
    // Positive control. Every assertion below checks that something throws; if
    // the function threw unconditionally they would all pass.
    const routes = await discoverRoutes(APP_DIR);
    expect(() => assertRouteManifest(routes)).not.toThrow();
  });

  it('rejects a route with no descriptor, and names the file', async () => {
    const routes = await discoverRoutes(fixture('missing'));
    let thrown: unknown;
    try { assertRouteManifest(routes); } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(RouteManifestError);
    expect((thrown as RouteManifestError).message).toMatch(/no `access` descriptor/);
    // The message has to name the file, or the failure is a puzzle at 3am.
    expect((thrown as RouteManifestError).offending.join()).toMatch(/route\.ts/);
  });

  it('rejects a route claiming post-exit reachability REQ-022 does not grant', async () => {
    // The window reaches three surfaces and nothing else. A fourth is a
    // blocker, not a finding — so it stops the server rather than logging.
    const routes = await discoverRoutes(fixture('badpostexit'));
    expect(() => assertRouteManifest(routes)).toThrow(/post-exit reachability/i);
  });

  it('rejects an EMPTY manifest', async () => {
    // Without this, pointing the walk at a directory that does not exist would
    // produce zero routes and pass every other check — a green boot check that
    // has checked nothing, which is the failure shape this project keeps hitting.
    await expect(discoverRoutes(fixture('does-not-exist'))).resolves.toEqual([]);
    expect(() => assertRouteManifest([])).toThrow(/empty/i);
  });

  it('rejects a post-exit route that does not require a session', async () => {
    expect(() => assertRouteManifest([{
      path: '/api/me/export', file: 'x', // on the allowlist, so that check passes
      access: { auth: 'public', tenantSettingGated: false, postExit: true },
    }])).toThrow(/must require an authenticated session/i);
  });

  it('rejects a malformed descriptor, including a missing postExit', async () => {
    // `postExit: undefined` would be falsy and therefore right by accident.
    // REQ-022's allowlist only means something if every route states its answer.
    expect(() => assertRouteManifest([{
      path: '/api/x', file: 'x',
      access: { auth: 'employee', tenantSettingGated: true } as never,
    }])).toThrow(/malformed/i);
  });
});

describe('the boot check itself', () => {
  it('exits non-zero when a route in the REAL app declares nothing', async () => {
    // The unit tests above prove the pieces. This proves the thing that
    // actually protects the deployment: `pnpm start` runs `prestart`, which
    // runs this script, and the script must refuse.
    //
    // A real file is created under app/ and removed again, because a fixture
    // directory would not prove that the SHIPPED path is wired up.
    const { spawnSync } = await import('node:child_process');
    const { mkdir, writeFile, rm } = await import('node:fs/promises');
    const stray = resolve(APP_DIR, 'api', '__boot_probe__');

    const run = () => spawnSync(process.execPath, [resolve(here, '..', 'src', 'check-routes.ts')],
      { encoding: 'utf8', cwd: resolve(here, '..') });

    // Baseline: clean tree, check passes. Without this the assertion below
    // could be satisfied by a script that always fails.
    const before = run();
    expect(before.status, `clean boot check should pass:\n${before.stderr}`).toBe(0);
    expect(before.stdout).toMatch(/Route manifest OK/);

    try {
      await mkdir(stray, { recursive: true });
      await writeFile(
        resolve(stray, 'route.ts'),
        'export function GET() { return new Response("no descriptor"); }\n',
        'utf8');

      const during = run();
      expect(during.status, 'an undeclared route did NOT stop the boot').toBe(1);
      expect(during.stderr).toMatch(/refusing to start/i);
      expect(during.stderr).toMatch(/__boot_probe__/);
    } finally {
      await rm(stray, { recursive: true, force: true });
    }

    // ...and it recovers once the stray route is gone.
    const after = run();
    expect(after.status, `boot check should pass again:\n${after.stderr}`).toBe(0);
  });
});

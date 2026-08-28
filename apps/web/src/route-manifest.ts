/**
 * The route manifest walk — REQ-001, REQ-022, SEC-01.
 *
 * There is no list of routes anywhere in this repository. There is this walk,
 * which reads the same directory Next.js serves, and `assertRouteManifest` in
 * `packages/core`, which decides whether what it found is acceptable.
 *
 * That split is the whole design. Feature 001 shipped a hand-written list of
 * tenant-scoped tables, it omitted the one table that mattered, and 28 passing
 * tests never noticed — twice. A hand-maintained list of routes fails the same
 * way and takes the post-exit allowlist down with it. So: if a route file
 * exists, this walk finds it; if it does not declare what may reach it, the
 * server does not start.
 */
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DiscoveredRoute, RouteAccess } from '@hrms/core/route-access';

/** Files Next.js treats as a servable endpoint. */
const ROUTE_FILES = new Set(['route.ts', 'route.tsx', 'page.tsx']);

/**
 * Turns a file path under `app/` into the URL it serves.
 *
 * `app/api/health/route.ts`      -> `/api/health`
 * `app/(employee)/record/page.tsx` -> `/record`   — route groups are grouping
 *                                     only, and Next does not put them in the
 *                                     URL. Leaving them in would make the
 *                                     post-exit allowlist compare against paths
 *                                     that can never match.
 */
export function urlPathFor(relativeFile: string): string {
  const parts = relativeFile.split(/[\\/]/);
  parts.pop(); // drop route.ts / page.tsx
  const segments = parts.filter((p) => !(p.startsWith('(') && p.endsWith(')')));
  return '/' + segments.join('/');
}

async function* walkFiles(dir: string, base: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // the directory does not exist; the caller's empty-manifest check fires
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walkFiles(full, base);
    } else if (ROUTE_FILES.has(entry.name)) {
      yield full.slice(base.length + 1);
    }
  }
}

/**
 * Finds every route under `appDir` and reads its `access` export.
 *
 * A module that throws on import is reported as undeclared rather than crashing
 * the walk: "this route could not be checked" and "this route was not declared"
 * both mean the same thing at boot, which is that we do not know who may reach
 * it, and both must stop the server.
 */
export async function discoverRoutes(appDir: string): Promise<DiscoveredRoute[]> {
  const found: DiscoveredRoute[] = [];
  for await (const relative of walkFiles(appDir, appDir)) {
    const absolute = join(appDir, relative);
    let access: RouteAccess | undefined;
    try {
      const mod = (await import(pathToFileURL(absolute).href)) as { access?: RouteAccess };
      access = mod.access;
    } catch {
      access = undefined;
    }
    found.push({
      path: urlPathFor(relative),
      file: `app${sep}${relative}`,
      access,
    });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

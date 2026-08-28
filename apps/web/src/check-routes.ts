/**
 * The boot check — run before the server serves anything, and in CI.
 *
 * A route with no `access` descriptor is not "public by default" and not
 * "denied by default" either. It is a route nobody has decided about, and the
 * only safe response to that is to refuse to start. Degrading — serving the
 * other routes and hoping — is how a post-exit allowlist quietly becomes a
 * denylist and how REQ-022 decays one release at a time.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Imported from the subpath, not the package index: the index pulls in `pg`
// and the whole domain layer, and a boot check that cannot run without a
// database driver is a boot check that will eventually be skipped.
import { assertRouteManifest, RouteManifestError } from '@hrms/core/route-access';
import { discoverRoutes } from './route-manifest.ts';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');

const routes = await discoverRoutes(appDir);

try {
  assertRouteManifest(routes);
} catch (err) {
  if (err instanceof RouteManifestError) {
    console.error('\nRoute manifest check FAILED — refusing to start.\n');
    console.error(err.message);
    console.error(
      '\nEvery route file must export:\n' +
      "  export const access: RouteAccess = { auth, tenantSettingGated, postExit };\n",
    );
    process.exit(1);
  }
  throw err;
}

console.log(`Route manifest OK — ${routes.length} route(s) checked:`);
for (const r of routes) {
  console.log(
    `  ${r.path.padEnd(28)} auth=${r.access!.auth} ` +
    `settingGated=${r.access!.tenantSettingGated} postExit=${r.access!.postExit}`,
  );
}

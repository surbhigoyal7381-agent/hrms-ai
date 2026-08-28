import type { RouteAccess } from '@hrms/core';
import { guarded } from '../../../src/guard.ts';

/**
 * Liveness only. It says the process is up; it says nothing about the database,
 * the tenant, or any person — so it is the one route in this application that is
 * genuinely public.
 *
 * Every route file must export one of these. The walk in src/route-manifest.ts
 * finds this file whether or not anybody remembered to register it, and the boot
 * check refuses to start the server if the descriptor is missing.
 */
export const access: RouteAccess = {
  auth: 'public',
  tenantSettingGated: false,
  postExit: false,
};

/**
 * Wrapped like every other route, even though it is public and gates nothing.
 *
 * Uniformity IS the control. The moment one route is allowed to skip the
 * wrapper "because it obviously does not need it", the next one skips it
 * because it looks like that one, and the gate becomes a convention. The guard
 * costs this route nothing: a public, ungated route is decided without touching
 * the database, so liveness still answers during an outage.
 */
export const GET = guarded('/api/health', () =>
  Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } }),
);

import type { RouteAccess } from '@hrms/core';

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

export function GET() {
  return Response.json({ status: 'ok' });
}

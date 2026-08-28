import type { RouteAccess } from '@hrms/core/route-access';
// Claims post-exit reachability REQ-022 does not grant.
export const access: RouteAccess = { auth: 'employee', tenantSettingGated: false, postExit: true };
export function GET() { return new Response('ok'); }

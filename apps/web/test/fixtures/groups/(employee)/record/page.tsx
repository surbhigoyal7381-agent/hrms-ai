import type { RouteAccess } from '@hrms/core/route-access';
export const access: RouteAccess = { auth: 'employee', tenantSettingGated: true, postExit: false };
export default function Page() { return null; }

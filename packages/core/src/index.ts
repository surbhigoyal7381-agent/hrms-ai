/**
 * The public surface of `packages/core`.
 *
 * `apps/web` imports from here and never reaches into `src/` by path, so the
 * boundary between the transport layer and the domain is a thing you can see in
 * a diff rather than a convention. Anything not exported here is internal.
 */
export {
  withTenant,
  withTenantForResolution,
  resolveTenantIdForSigninSlug,
  createAppPool,
  type AppPool,
  asEmploymentId,
  type Actor,
  type EmploymentId,
  type Tx,
} from './db.js';

export {
  decide,
  authorise,
  ForbiddenError,
  type Principal,
  type Role,
  type Action,
  type Decision,
  type ResourceContext,
} from './policy.js';

export {
  writeAudit,
  writeSystemRead,
  resolvePurpose,
  ALL_PURPOSE_CODES,
  type PurposeCode,
  type AuditEvent,
} from './audit.js';

export {
  postgresRecordViewGate,
  requireRecordView,
  RecordViewDisabledError,
  type RecordViewGate,
  type RecordViewResolution,
  type SettingSource,
} from './settings.js';

export {
  readAccessLog,
  ACCESS_LOG_PAGE_SIZE,
  type AccessLogEntry,
  type AccessLogPage,
  type AccessLogQuery,
} from './access-log.js';

export {
  readCurrentValues,
  readChangeHistory,
  HISTORY_PAGE_SIZE,
  TemporalAmbiguityError,
  type CurrentValues,
  type HistoryEntry,
  type HistoryPage,
} from './record-view.js';

export {
  resolveRequestContext,
  type RequestContext,
  type Lifecycle,
} from './request-context.js';

export {
  decideRouteAccess,
  type AccessRequest,
  type AccessDecision,
  type AccessDenialCode,
  type AccessPrincipal,
  type SettingState,
} from './access-control.js';

export {
  assertRouteManifest,
  RouteManifestError,
  POST_EXIT_ALLOWED_PATHS,
  type RouteAccess,
  type AuthRequirement,
  type DiscoveredRoute,
} from './route-access.js';

export {
  erasePerson,
  hasLegalHold,
  CORE_HR_STORES,
  type ErasureMode,
  type ErasureResult,
  type StoreEraser,
} from './erasure.js';

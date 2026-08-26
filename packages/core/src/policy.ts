/**
 * Authorisation — REQ-001 SEC-01, and Part 5 of 20-requirements.md.
 *
 * Tenant isolation (RLS) answers "which organisation's data is this?".
 * It does NOT answer "may this person do this to that person". Without the
 * check below, any authenticated employee can change anyone's job title,
 * manager and reporting line — RLS lets it through because it is the same
 * tenant.
 *
 * A role table and a policy function, per Gate 0's own smell list — not a DSL.
 * Escalate to Cerbos or OpenFGA when the third genuine exception appears, and
 * not before.
 *
 * This lives in packages/core, not in middleware, because packages/core is
 * framework-free and every mutating operation calls it directly. Authorisation
 * that lives only in a transport layer is authorisation you can walk around.
 */

import type { Actor } from './db.js';

export type Role = 'employee' | 'manager' | 'hr_admin' | 'it_admin';

export type Action =
  | 'employment.create'
  | 'employment.change'
  | 'employment.exit'
  | 'person.self_correct'
  | 'person.read_sensitive'
  | 'directory.export'
  | 'import.run';

/**
 * Who is acting, as ONE identity.
 *
 * This used to carry `actorId` AND a separate nullable `employmentId`. The
 * policy below compared the second; `applyEmploymentChange` recorded the first
 * in `audit_log.actor_id`, `analytics_event.actor_id` and
 * `transparency_ledger.decided_by`. Nothing made them agree, so authorisation
 * was decided about one person and filed under another, and erasure — which
 * looks for the acting EMPLOYMENT — could never find the rows it had to clear.
 *
 * There is now one field. There is no second slot to put the wrong value in,
 * `EmploymentId` will not accept a bare string, and migration 0002 gives every
 * one of those columns a composite foreign key into `employment (tenant_id, id)`
 * so the database refuses the wrong value even under a cast.
 *
 * `actorEmploymentId` is NOT nullable, and that is the deliberate part: an actor
 * with no employment in this tenant cannot act on employment records. See the
 * decision log entry of 2026-08-26 for the alternatives that were rejected.
 */
export interface Principal extends Actor {
  roles: ReadonlySet<Role>;
}

export interface ResourceContext {
  /** The employment being acted upon. */
  employmentId: string;
  /** Managers of that employment, on the relevant date. */
  managerEmploymentId: string | null;
  secondaryManagerEmploymentId: string | null;
  /** The principal's OWN manager — needed to detect a reciprocal change. */
  principalManagerEmploymentId?: string | null;
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message: string, readonly action: Action) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface Decision {
  allowed: boolean;
  reason: string;
  /** Recorded in the ledger: a manager changing their own manager's record. */
  reciprocal?: boolean;
}

export function decide(
  principal: Principal,
  action: Action,
  resource: ResourceContext | null,
): Decision {
  const isHr = principal.roles.has('hr_admin');
  // The SAME field that will be recorded as the decider. When these were two
  // fields, the policy could allow Rohan and the ledger could name HR.
  const acting = principal.actorEmploymentId;
  const isSelf = resource !== null && acting === resource.employmentId;
  const isPrimaryManager =
    resource !== null && resource.managerEmploymentId === acting;
  const isSecondaryManager =
    resource !== null && resource.secondaryManagerEmploymentId === acting;

  switch (action) {
    case 'employment.create':
    case 'employment.exit':
    case 'import.run':
    case 'directory.export':
      return isHr
        ? { allowed: true, reason: 'hr_admin' }
        : { allowed: false, reason: 'Only HR can do this.' };

    case 'employment.change': {
      // Self-approval is a control failure. An HR admin may correct factual
      // details about themselves, but may NOT change their own job, band or
      // reporting line — that is the case every real system gets wrong.
      if (isSelf) {
        return {
          allowed: false,
          reason: 'You cannot change your own job, team or reporting line. Ask HR.',
        };
      }
      // A dotted-line manager reads, but never writes.
      if (isSecondaryManager && !isPrimaryManager && !isHr) {
        return {
          allowed: false,
          reason: 'Dotted-line managers can view this record but not change it.',
        };
      }
      if (isHr) return { allowed: true, reason: 'hr_admin' };
      if (isPrimaryManager) {
        // A manager changing the record of someone who manages THEM is
        // permitted but flagged — visible to HR, per Part 5.
        //
        // The real predicate is "is the resource my own manager", not "do both
        // ids exist" — the latter is structurally always true inside this
        // branch, which flagged every ordinary manager change.
        const reciprocal =
          resource.principalManagerEmploymentId != null &&
          resource.principalManagerEmploymentId === resource.employmentId;
        return { allowed: true, reason: 'primary_manager', reciprocal };
      }
      return {
        allowed: false,
        reason: 'Only this person’s manager or HR can change their record.',
      };
    }

    case 'person.self_correct':
      // Everyone may correct their own factual details. Nobody may correct
      // anyone else's — not even HR, who must use the correction workflow so
      // the change is attributed and auditable (COMP-25).
      return isSelf
        ? { allowed: true, reason: 'self' }
        : { allowed: false, reason: 'You can only update your own details.' };

    case 'person.read_sensitive':
      if (isSelf) return { allowed: true, reason: 'self' };
      if (isHr) return { allowed: true, reason: 'hr_admin' };
      return { allowed: false, reason: 'Not permitted.' };

    default: {
      // Exhaustiveness: a new action added without a rule must fail closed,
      // not fall through to allowed.
      const never: never = action;
      return { allowed: false, reason: `No rule for action ${String(never)}` };
    }
  }
}

/** Throws unless permitted. Every mutating operation calls this first. */
export function authorise(
  principal: Principal,
  action: Action,
  resource: ResourceContext | null,
): Decision {
  const d = decide(principal, action, resource);
  if (!d.allowed) throw new ForbiddenError(d.reason, action);
  return d;
}

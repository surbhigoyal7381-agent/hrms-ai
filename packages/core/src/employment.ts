import type { Tx, Actor } from './db.js';
import {
  assertBusinessDate,
  planChange,
  ValidationError,
  ConflictError,
  type BusinessDate,
  type VersionRow,
} from './temporal.js';
import { authorise, type Principal } from './policy.js';

/**
 * RULE-002 — the point-in-time predicate. ONE copy, interpolated everywhere.
 *
 * `superseded_at IS NULL`  — only system-live rows (BLOCKER-4 fix).
 * `valid_to > :asOf`       — half-open interval [valid_from, valid_to).
 * `valid_from < valid_to`  — excludes zero-length intervals.
 *
 * Dropping any clause returns two rows for one person and doubles every
 * downstream headcount.
 */
export const POINT_IN_TIME_PREDICATE = (alias: string, asOfParam: string) => `
  ${alias}.superseded_at IS NULL
  AND ${alias}.valid_from <= ${asOfParam}
  AND (${alias}.valid_to IS NULL OR ${alias}.valid_to > ${asOfParam})
  AND (${alias}.valid_to IS NULL OR ${alias}.valid_from < ${alias}.valid_to)
`;

/**
 * Fields an employee may correct about themselves (REQ-006).
 *
 * This allowlist is enforced SERVER-SIDE. A UI-only restriction is not a
 * permission — it is a suggestion that anyone with devtools can decline.
 */
export const SELF_CORRECTABLE = Object.freeze([
  'preferred_name',
  'pronouns',
  'personal_email',
  'personal_phone',
] as const);

export type SelfCorrectableField = (typeof SELF_CORRECTABLE)[number];

export interface ChangeInput {
  employmentId: string;
  effectiveFrom: BusinessDate;
  reason: string;
  decidedByName: string;
  attributes: {
    orgUnitId?: string;
    positionId?: string | null;
    jobTitle?: string;
    managerEmploymentId?: string | null;
    secondaryManagerEmploymentId?: string | null;
    employmentType?: string;
    workLocation?: string | null;
    costCentre?: string | null;
  };
  idempotencyKey?: string;
}

/**
 * REQ-003 — apply an effective-dated change.
 *
 * Never updates a version's business data. Closes the covering version's
 * `valid_to` and appends a new one, then writes the audit entry and the
 * transparency ledger entry in the SAME transaction — so it is impossible to
 * change a person's record without the person being able to see why.
 */
export async function applyEmploymentChange(
  tx: Tx,
  principal: Principal,
  input: ChangeInput,
): Promise<{ versionId: string; superseded: string[]; reciprocal: boolean }> {
  // ONE identity, and it is an employment id.
  //
  // Round 2 collapsed `actor` and `principal` into one parameter but kept two
  // FIELDS on the Principal, and picked the wrong one: `actorId` was a login
  // account id, `employmentId` was the employment the policy actually reasoned
  // about. So the policy allowed Rohan and the ledger named HR, and erasure —
  // which searches by employment — never found the rows. `Principal` now has a
  // single `actorEmploymentId`, so `actor` is the principal.
  const actor: Actor = principal;
  assertBusinessDate(input.effectiveFrom, 'effectiveFrom');

  // reason NOT NULL is a product decision, not a database detail
  // (docs/07-fairness-and-transparency.md Part 2). Check it here too so the
  // error is a friendly 422 rather than a constraint violation.
  if (!input.reason || input.reason.trim().length === 0) {
    throw new ValidationError('Please add a reason. The employee will see this.', 'reason');
  }

  const emp = await tx.query(
    `SELECT id, hire_date::text AS hire_date, exit_date::text AS exit_date, status
       FROM employment WHERE id = $1`,
    [input.employmentId],
  );
  if (emp.rowCount === 0) {
    // 404, not 403: a 403 across tenants confirms the record exists (REQ-001).
    throw new ValidationError('Employment not found', 'employmentId');
  }
  const employment = emp.rows[0];

  if (input.effectiveFrom < employment.hire_date) {
    throw new ValidationError(
      `Effective date cannot be before the hire date (${employment.hire_date})`,
      'effectiveFrom',
    );
  }
  if (employment.status === 'exited' || employment.status === 'cancelled') {
    throw new ValidationError(
      'This employment has ended. Reopen it before making changes.',
      'employmentId',
    );
  }

  // SEC-01 / REQ-001. Tenant isolation says WHICH organisation's data this is.
  // It does not say whether THIS person may do THIS to THAT person. Without
  // this call, any authenticated employee can rewrite anyone's job and manager.
  const currentForPolicy = await tx.query(
    `SELECT ev.manager_employment_id, ev.secondary_manager_employment_id
       FROM employment_version ev
      WHERE ev.employment_id = $1
        AND ${POINT_IN_TIME_PREDICATE('ev', '$2')}`,
    [input.employmentId, input.effectiveFrom],
  );
  const pm = await tx.query(
    `SELECT ev.manager_employment_id FROM employment_version ev
      WHERE ev.employment_id = $1
        AND ${POINT_IN_TIME_PREDICATE('ev', '$2')}`,
    [principal.actorEmploymentId, input.effectiveFrom],
  );
  const principalManager: string | null = pm.rows[0]?.manager_employment_id ?? null;
  const decision = authorise(principal, 'employment.change', {
    employmentId: input.employmentId,
    managerEmploymentId: currentForPolicy.rows[0]?.manager_employment_id ?? null,
    secondaryManagerEmploymentId:
      currentForPolicy.rows[0]?.secondary_manager_employment_id ?? null,
    principalManagerEmploymentId: principalManager,
  });

  // MAJOR-3: a reporting cycle makes every recursive org-chart query hang, and
  // reorgs create them routinely when two managers are swapped in the wrong
  // order. The one-hop case is caught by a CHECK; this catches the rest.
  if (input.attributes.managerEmploymentId) {
    const path = await findReportingCycle(
      tx, input.employmentId, input.attributes.managerEmploymentId, input.effectiveFrom);
    if (path) {
      throw new ValidationError(
        `That would make ${path.join(' report to ')} — a loop. Pick a different manager.`,
        'managerEmploymentId',
      );
    }
  }

  if (input.idempotencyKey) {
    const dupe = await tx.query(
      `SELECT id FROM employment_version
        WHERE employment_id = $1 AND idempotency_key = $2
          AND superseded_at IS NULL`,
      [input.employmentId, input.idempotencyKey],
    );
    if (dupe.rowCount && dupe.rowCount > 0) {
      return { versionId: dupe.rows[0].id, superseded: [], reciprocal: false };
    }
  }

  // Select the FULL row, not just the temporal columns: the current version is
  // the merge base for attributes the caller did not supply. Selecting only the
  // interval columns here silently carries NULL into every unchanged attribute.
  // Select the FULL row: the current version is the merge base for attributes
  // the caller did not supply. Selecting only the interval columns silently
  // carries NULL into every unchanged attribute.
  //
  // The *_txt aliases are deliberate and must not be collapsed into `*`:
  //   1. `SELECT *, valid_from::text AS valid_from` yields TWO columns named
  //      valid_from and makes ORDER BY ambiguous.
  //   2. node-postgres maps `date` columns to JS Date objects, which carry a
  //      timezone. Business dates must stay strings all the way through.
  const existing = await tx.query(
    `SELECT ev.*,
            ev.valid_from::text  AS valid_from_txt,
            ev.valid_to::text    AS valid_to_txt,
            ev.recorded_at::text AS recorded_at_txt
       FROM employment_version ev
      WHERE ev.employment_id = $1
        AND ev.superseded_at IS NULL
      ORDER BY ev.valid_from, ev.recorded_at
      FOR UPDATE`,
    [input.employmentId],
  );

  const rows: VersionRow[] = existing.rows.map((r) => ({
    id: r.id,
    validFrom: r.valid_from_txt,
    validTo: r.valid_to_txt,
    recordedAt: r.recorded_at_txt,
  }));

  const current = rows.find((r) => r.validTo === null || r.validFrom < r.validTo);
  if (!current) throw new ConflictError('No current version for this employment');

  const currentRow = existing.rows.find((r) => r.id === current.id)!;
  const plan = planChange(rows, input.effectiveFrom);

  // BLOCKER-4 fix — system time is preserved.
  //
  // We do NOT overwrite valid_to. valid_to IS the answer to "what did we believe
  // on date T", and rewriting it destroys the only record of that belief — which
  // is exactly what an auditor asks for when reproducing a payroll run after a
  // retroactive change.
  //
  // Instead: stamp superseded_at on the old row (a system-time close, not a
  // business-data edit) and APPEND a replacement carrying the new valid_to.
  // The old row keeps its original valid_to forever.
  if (plan.close) {
    await tx.query(
      `UPDATE employment_version SET superseded_at = now() WHERE id = $1`,
      [plan.close.id],
    );
    await tx.query(
      `INSERT INTO employment_version (
         tenant_id, employment_id, valid_from, valid_to,
         org_unit_id, position_id, job_title,
         manager_employment_id, secondary_manager_employment_id,
         employment_type, work_location, cost_centre, decided_by, reason)
       SELECT tenant_id, employment_id, valid_from, $2,
              org_unit_id, position_id, job_title,
              manager_employment_id, secondary_manager_employment_id,
              employment_type, work_location, cost_centre, decided_by, reason
         FROM employment_version WHERE id = $1`,
      [plan.close.id, plan.close.validTo],
    );
  }
  // Anything starting on or after the effective date is superseded outright.
  // The row survives, with its original interval intact, for the audit trail.
  for (const id of plan.supersededIds) {
    await tx.query(
      `UPDATE employment_version SET superseded_at = now() WHERE id = $1`,
      [id],
    );
  }

  const merged = { ...currentRow, ...toColumns(input.attributes) };

  let inserted;
  try {
    inserted = await tx.query(
      `INSERT INTO employment_version (
         tenant_id, employment_id, valid_from, valid_to,
         org_unit_id, position_id, job_title,
         manager_employment_id, secondary_manager_employment_id,
         employment_type, work_location, cost_centre,
         decided_by, reason, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        actor.tenantId, input.employmentId, plan.insert.validFrom, plan.insert.validTo,
        merged.org_unit_id, merged.position_id, merged.job_title,
        merged.manager_employment_id, merged.secondary_manager_employment_id,
        merged.employment_type, merged.work_location, merged.cost_centre,
        actor.actorEmploymentId, input.reason.trim(), input.idempotencyKey ?? null,
      ],
    );
  } catch (err: any) {
    // The exclusion constraint is the last line of defence against a
    // concurrency race producing two overlapping versions.
    if (err?.code === '23P01') {
      throw new ConflictError(
        'Someone else just changed this record. Reload to see what changed.',
      );
    }
    throw err;
  }

  await writeAudit(tx, actor, {
    action: 'employment.attribute_changed',
    resourceType: 'employment',
    resourceId: input.employmentId,
    before: redact(currentRow),
    after: redact(merged),
  });

  // Same transaction as the change itself: it is impossible to alter a person's
  // record without the person being able to see who did it and why.
  await tx.query(
    `INSERT INTO transparency_ledger
       (tenant_id, subject_employment_id, what, decided_by, decided_by_name,
        reason, effective_from, ai_involved, reciprocal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)`,
    [
      actor.tenantId, input.employmentId,
      describeChange(
        currentRow, merged, input.effectiveFrom,
        plan.supersededIds[0]
          ? (rows.find((r) => r.id === plan.supersededIds[0])?.validFrom ?? null)
          : null,
      ),
      actor.actorEmploymentId, input.decidedByName,
      input.reason.trim(), input.effectiveFrom, decision.reciprocal ?? false,
    ],
  );

  await emit(tx, actor, 'employee.attribute_changed', {
    // Property NAMES only, never values — the analytics table is not a
    // back door around field-level permissions.
    attributes: Object.keys(input.attributes),
  });

  return {
    versionId: inserted.rows[0].id,
    superseded: plan.supersededIds,
    reciprocal: decision.reciprocal ?? false,
  };
}

/**
 * Walks the reporting chain upward from `proposedManagerId` looking for
 * `employmentId`. Returns the cycle path if one would be created.
 * Bounded at 100 hops so a pre-existing cycle cannot hang this check itself.
 */
async function findReportingCycle(
  tx: Tx,
  employmentId: string,
  proposedManagerId: string,
  asOf: BusinessDate,
): Promise<string[] | null> {
  const path: string[] = [employmentId];
  let cursor: string | null = proposedManagerId;
  for (let hops = 0; cursor && hops < 100; hops++) {
    path.push(cursor);
    if (cursor === employmentId) return path;
    const r: any = await tx.query(
      `SELECT ev.manager_employment_id FROM employment_version ev
        WHERE ev.employment_id = $1
          AND ${POINT_IN_TIME_PREDICATE('ev', '$2')}`,
      [cursor, asOf],
    );
    cursor = r.rows[0]?.manager_employment_id ?? null;
  }
  return null;
}

/**
 * "What did we believe on date T?" — the system-time query (RULE-001, Q-03).
 * Its answer must never change because of something recorded after T.
 */
export async function employmentAsKnownAt(
  tx: Tx,
  employmentId: string,
  asOf: BusinessDate,
  asKnownAt: string,
): Promise<Record<string, unknown> | null> {
  assertBusinessDate(asOf, 'asOf');
  const res = await tx.query(
    `SELECT ev.* FROM employment_version ev
      WHERE ev.employment_id = $1
        AND ev.recorded_at <= $3
        AND (ev.superseded_at IS NULL OR ev.superseded_at > $3)
        AND ev.valid_from <= $2
        AND (ev.valid_to IS NULL OR ev.valid_to > $2)
        AND (ev.valid_to IS NULL OR ev.valid_from < ev.valid_to)`,
    [employmentId, asOf, asKnownAt],
  );
  return res.rows[0] ?? null;
}

function toColumns(a: ChangeInput['attributes']): Record<string, unknown> {
  const map: Record<string, string> = {
    orgUnitId: 'org_unit_id',
    positionId: 'position_id',
    jobTitle: 'job_title',
    managerEmploymentId: 'manager_employment_id',
    secondaryManagerEmploymentId: 'secondary_manager_employment_id',
    employmentType: 'employment_type',
    workLocation: 'work_location',
    costCentre: 'cost_centre',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    const column = map[k];
    // An attribute with no column mapping is a programming error, not a
    // silently-ignored field — silently dropping it loses a change the user
    // believes they made.
    if (!column) throw new ValidationError(`Unknown attribute "${k}"`, k);
    if (v !== undefined) out[column] = v;
  }
  return out;
}

function describeChange(
  before: any,
  after: any,
  effectiveFrom: BusinessDate,
  supersededEffectiveFrom: BusinessDate | null,
): string {
  const parts: string[] = [];
  if (before.job_title !== after.job_title) parts.push(`job title to "${after.job_title}"`);
  if (before.org_unit_id !== after.org_unit_id) parts.push('team');
  if (before.manager_employment_id !== after.manager_employment_id) parts.push('manager');

  // RULE-001: "the fact that it changed after the fact is itself shown in the
  // ledger." Two entries both saying "Changed team" hide the thing that
  // actually moved — and the effective date is what changes someone's pay.
  if (supersededEffectiveFrom && supersededEffectiveFrom !== effectiveFrom) {
    return `Effective date corrected from ${supersededEffectiveFrom} to ${effectiveFrom}` +
      (parts.length ? ` (${parts.join(', ')})` : '');
  }
  return parts.length
    ? `Changed ${parts.join(', ')}, effective ${effectiveFrom}`
    : `Updated employment details, effective ${effectiveFrom}`;
}

/** PRIV-07 — identity fields never reach the audit payload or the logs. */
const REDACTED_KEYS = new Set(['national_id_ref', 'personal_email', 'personal_phone', 'date_of_birth']);

export function redact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = REDACTED_KEYS.has(k) ? '[REDACTED]' : v;
  }
  return out;
}

export async function writeAudit(
  tx: Tx,
  actor: Actor,
  e: {
    action: string;
    resourceType: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
    sensitiveRead?: boolean;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log
       (tenant_id, actor_id, action, resource_type, resource_id,
        before_data, after_data, sensitive_read)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      actor.tenantId, actor.actorEmploymentId, e.action, e.resourceType, e.resourceId,
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
      e.sensitiveRead ?? false,
    ],
  );
}

async function emit(tx: Tx, actor: Actor, name: string, props: unknown): Promise<void> {
  await tx.query(
    `INSERT INTO analytics_event (tenant_id, name, actor_id, props)
     VALUES ($1,$2,$3,$4)`,
    [actor.tenantId, name, actor.actorEmploymentId, JSON.stringify(props)],
  );
}

/** REQ-004 — point-in-time read. The predicate lives in exactly one place. */
export async function employmentAsOf(
  tx: Tx,
  employmentId: string,
  asOf: BusinessDate,
): Promise<Record<string, unknown> | null> {
  assertBusinessDate(asOf, 'asOf');
  const res = await tx.query(
    `SELECT ev.* FROM employment_version ev
      WHERE ev.employment_id = $1
        AND ${POINT_IN_TIME_PREDICATE('ev', '$2')}`,
    [employmentId, asOf],
  );
  if ((res.rowCount ?? 0) > 1) {
    // Cannot happen given the exclusion constraint. If it ever does, failing
    // loudly beats returning a number someone will put in a board deck.
    throw new ConflictError(
      `Temporal integrity violation: ${res.rowCount} current versions for employment ${employmentId} on ${asOf}`,
    );
  }
  return res.rows[0] ?? null;
}

/** REQ-004 — headcount for an org unit on a business date. */
export async function headcountAsOf(
  tx: Tx,
  orgUnitId: string,
  asOf: BusinessDate,
): Promise<number> {
  assertBusinessDate(asOf, 'asOf');
  const res = await tx.query(
    `SELECT count(DISTINCT ev.employment_id)::int AS n
       FROM employment_version ev
       JOIN employment e ON e.id = ev.employment_id
      WHERE ev.org_unit_id = $1
        AND ${POINT_IN_TIME_PREDICATE('ev', '$2')}
        AND e.hire_date <= $2
        AND (e.exit_date IS NULL OR e.exit_date > $2)
        AND e.status <> 'cancelled'`,
    [orgUnitId, asOf],
  );
  return res.rows[0].n;
}

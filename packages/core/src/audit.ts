/**
 * The audit write — REQ-014, REQ-020, RULE-004, RULE-005, COMP-53.
 *
 * Feature 001 wrote "who did what". This feature has to render it to the person
 * it was done to, which turns three soft gaps into hard requirements:
 *
 *   * A read must say whether a PERSON or a JOB did it. `actor_id IS NULL` used
 *     to mean both "a nightly job" and "the viewer was erased". Guessing
 *     "system" would tell Aisha no person read her record when one did — the
 *     most damaging false sentence this feature can produce. `actor_kind` is
 *     recorded at write time and erasure never touches it.
 *   * A read must still NAME the viewer after they leave or are erased. The
 *     name is captured into the row, not joined at display time — a join
 *     returns today's name, or nothing at all once the person is gone.
 *   * A read must say WHY. `action` restates itself ("Looking at your
 *     details"); `purpose` is a business reason ("annual pay review").
 */
import type { Tx, Actor, EmploymentId } from './db.js';

/**
 * RULE-004's closed list. This is a required argument, not an optional one:
 * a new read path cannot compile without choosing a purpose, which turns
 * "somebody forgot to set it" from a silent gap into a build failure.
 */
export type PurposeCode =
  | 'pay_review'
  | 'payroll_run'
  | 'record_correction'
  | 'onboarding'
  | 'case_handling'
  | 'employee_request'
  | 'support';

export interface AuditEvent {
  action: string;
  resourceType: string;
  resourceId: string;
  /** Whose record this was ABOUT. Required for a sensitive read (REQ-018). */
  subjectPersonId: string | null;
  purpose: PurposeCode | null;
  before?: unknown;
  after?: unknown;
  sensitiveRead?: boolean;
}

/**
 * A read or write by a PERSON.
 *
 * The viewer's name and role are resolved **inside the INSERT**, from the
 * database, rather than taken from the caller. Two reasons, and the second is
 * the one that matters:
 *
 *   1. No extra round trip — it is one statement either way.
 *   2. The caller cannot forge them. Feature 001's review found `decided_by`
 *      being populated from a caller-supplied value the authorisation check
 *      never looked at; a caller-supplied display name would be the same defect
 *      wearing a different column. The name that lands in the row is the name
 *      the database holds for the employment that was authorised.
 *
 * `actor_role_label` is the job title held **on the day of the read**, via the
 * point-in-time predicate — so an entry from August still says what Meera was
 * in August, not what she is now (REQ-020).
 */
export async function writeAudit(
  tx: Tx,
  actor: Actor,
  e: AuditEvent,
): Promise<void> {
  const res = await tx.query(
    `INSERT INTO audit_log
       (tenant_id, actor_id, actor_kind, actor_display_name, actor_role_label,
        action, resource_type, resource_id, subject_person_id, purpose_code,
        before_data, after_data, sensitive_read)
     SELECT $1, e.id, 'human',
            coalesce(nullif(btrim(p.preferred_name), ''), p.legal_name),
            ev.job_title,
            $3, $4, $5, $6, $7::access_purpose_code, $8::jsonb, $9::jsonb, $10
       FROM employment e
       JOIN person p ON p.id = e.person_id
       LEFT JOIN LATERAL (
            SELECT v.job_title
              FROM employment_version v
             WHERE v.employment_id = e.id
               AND v.superseded_at IS NULL
               AND v.valid_from <= current_date
               AND (v.valid_to IS NULL OR v.valid_to > current_date)
             LIMIT 1) ev ON true
      WHERE e.id = $2`,
    [
      actor.tenantId, actor.actorEmploymentId,
      e.action, e.resourceType, e.resourceId,
      e.subjectPersonId, e.purpose,
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
      e.sensitiveRead ?? false,
    ],
  );
  // Zero rows means the acting employment does not exist or is in another
  // tenant. Silence here would mean an action happened with no trace, which is
  // the one thing REQ-014 exists to prevent.
  if ((res.rowCount ?? 0) !== 1) {
    throw new Error(
      `Audit write recorded no row: acting employment ${actor.actorEmploymentId} not found in this tenant`,
    );
  }
}

/**
 * A read by a scheduled job — REQ-006. Kept as a SEPARATE function, deliberately.
 *
 * If "system" were a flag on the human writer, a caller could pass it by
 * accident and a human read would be filed as a nightly batch. Two functions
 * means the classification is chosen by which one you call, and the human path
 * has no way to express "system" at all.
 */
export async function writeSystemRead(
  tx: Tx,
  ctx: { tenantId: string; serviceName: string },
  e: Omit<AuditEvent, 'before' | 'after'>,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log
       (tenant_id, actor_id, actor_kind, service_name,
        action, resource_type, resource_id, subject_person_id, purpose_code,
        sensitive_read)
     VALUES ($1, NULL, 'system', $2, $3, $4, $5, $6, $7::access_purpose_code, $8)`,
    [
      ctx.tenantId, ctx.serviceName,
      e.action, e.resourceType, e.resourceId,
      e.subjectPersonId, e.purpose, e.sensitiveRead ?? true,
    ],
  );
}

/**
 * RULE-004's fallback table, used when a row carries no `purpose_code` — a path
 * written before this feature, or one added later by someone who did not update
 * the list. The entry is ALWAYS shown; a log with silent exclusions is not a log.
 */
const PURPOSE_TEXT: Record<PurposeCode, string> = {
  pay_review: 'annual pay review',
  payroll_run: 'payroll run',
  record_correction: 'correcting your record',
  onboarding: 'setting up your record',
  case_handling: 'confidential casework',
  employee_request: 'something you asked for',
  support: 'helping with a support question',
};

const ACTION_FALLBACK: Record<string, string> = {
  'employment.attribute_changed': 'updating your record',
  'person.read_sensitive': 'looking at your details',
  'record.viewed_own': 'you opened your own record',
  'record.viewed_by_hr': 'HR opened your record',
  'export.own_data': 'you downloaded your data',
  'person.erased': 'deleting your data at your request',
};

export interface PurposeResolution {
  text: string | null;
  /** True when nothing matched — the caller shows "Reason not recorded" and alerts. */
  missing: boolean;
}

export function resolvePurpose(
  purpose: PurposeCode | null,
  action: string,
): PurposeResolution {
  if (purpose) return { text: PURPOSE_TEXT[purpose], missing: false };
  const fallback = ACTION_FALLBACK[action];
  if (fallback) return { text: fallback, missing: false };
  return { text: null, missing: true };
}

/** Test seam: the closed list, so a test can assert every value maps to text. */
export const ALL_PURPOSE_CODES: readonly PurposeCode[] = Object.freeze(
  Object.keys(PURPOSE_TEXT) as PurposeCode[],
);

export type { EmploymentId };

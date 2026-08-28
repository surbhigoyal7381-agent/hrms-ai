/**
 * What Aisha sees — REQ-002, REQ-003, REQ-004.
 *
 * Two read models. Current values ("what does my employer hold about me right
 * now") and change history ("what has ever been changed, by whom, and why").
 *
 * THE NATIONAL IDENTIFIER IS NOT HERE, and its absence is the design.
 *
 * REQ-002 as originally written asked for it masked to the last four
 * characters. RULE-012 says the column is application-layer encrypted with no
 * decryption path. Both cannot be true — the last four characters of ciphertext
 * are four meaningless characters presented to a person as their identity
 * number. The engineer checked and found there is no encryption anywhere in
 * this product, nothing writes the column, and it is always NULL. The
 * product manager ruled on 2026-08-26: **not shown, not masked, not blank, not
 * an empty labelled row, and not in the export.** An empty row labelled
 * "National ID" is worse than absence, because it invites "why is mine blank?"
 * and the honest answer is "the field is not used yet".
 *
 * So `national_id_ref` is not in any SELECT in this file. Not selected and then
 * dropped — never fetched. A field that is never loaded cannot be leaked by a
 * logger, a serialiser, an error page or a future refactor that spreads the row
 * into a response. There is a test asserting the string does not appear in the
 * query text, which would catch somebody adding `ev.*`-style convenience later.
 */
import type { Tx } from './db.js';

/**
 * More than one version is in effect on one date.
 *
 * Cannot happen given the exclusion constraint in migration 0001. If it ever
 * does, REQ-002 is explicit about what must happen: fail with a 500 and an
 * alert, rather than show Aisha one of two possible truths. Its own error type
 * so the transport can map it to a 503/500 without string-matching a message.
 */
export class TemporalAmbiguityError extends Error {
  readonly code = 'TEMPORAL_AMBIGUITY';
  constructor(message: string) {
    super(message);
    this.name = 'TemporalAmbiguityError';
  }
}

/**
 * A business date, `YYYY-MM-DD`. Never a timestamp.
 *
 * Attendance and payroll periods are business dates, not instants — one of the
 * one-way doors in CLAUDE.md §7. "Today" for Aisha is a question about her work
 * calendar, so the caller resolves it and passes it in; this module never calls
 * `new Date()`.
 */
export type BusinessDate = string;

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertBusinessDate(value: string, name: string): void {
  if (!BUSINESS_DATE.test(value)) {
    throw new TypeError(`${name} must be a business date (YYYY-MM-DD), got ${value}`);
  }
}

export interface CurrentValues {
  /** Person-level facts. */
  legalName: string;
  preferredName: string | null;
  pronouns: string | null;
  dateOfBirth: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  emergencyContact: string | null;
  profilePhotoUrl: string | null;

  /** Employment-level facts. */
  employeeNumber: string;
  workEmail: string | null;
  hireDate: string;
  exitDate: string | null;
  status: string;

  /**
   * The effective-dated attributes, as at the business date asked for.
   *
   * `null` when no version is in effect — a pre-hire whose first version starts
   * next Monday, for example. Null is a real answer here and is rendered as
   * "not set yet", never as a missing screen.
   */
  jobTitle: string | null;
  team: string | null;
  managerName: string | null;
  secondaryManagerName: string | null;
  employmentType: string | null;
  workLocation: string | null;

  /** Echoed back so the screen can say "as at" without recomputing it. */
  asOf: BusinessDate;
}

/**
 * The point-in-time predicate, written out rather than imported.
 *
 * `employmentAsOf` returns `SELECT ev.*`, which would pull every column of
 * `employment_version` into this read path. That is fine for a domain function
 * and wrong for a screen: this file's whole discipline is that a column not
 * named here is a column that cannot reach Aisha's browser. So the predicate is
 * shared in spirit and the projection is explicit.
 *
 * Both halves matter and both are easy to drop:
 *   superseded_at IS NULL     — the row we still believe
 *   valid_from <= d < valid_to — the row in effect on that date
 *   valid_from < valid_to     — excludes a zero-length correction artefact
 */
const IN_EFFECT = `
        ev.superseded_at IS NULL
    AND ev.valid_from <= $2
    AND (ev.valid_to IS NULL OR ev.valid_to > $2)
    AND (ev.valid_to IS NULL OR ev.valid_from < ev.valid_to)`;

const CURRENT_VALUES = `
  SELECT p.legal_name, p.preferred_name, p.pronouns,
         p.date_of_birth::text  AS date_of_birth,
         p.personal_email::text AS personal_email,
         p.personal_phone, p.emergency_contact, p.profile_photo_url,
         e.employee_number, e.work_email::text AS work_email,
         e.hire_date::text AS hire_date, e.exit_date::text AS exit_date,
         e.status::text AS status,
         ev.job_title, ev.employment_type::text AS employment_type, ev.work_location,
         ou.name AS team,
         mgr.display_name  AS manager_name,
         mgr2.display_name AS secondary_manager_name
    FROM employment e
    JOIN person p ON p.id = e.person_id
    LEFT JOIN LATERAL (
         SELECT ev.job_title, ev.employment_type, ev.work_location,
                ev.org_unit_id, ev.manager_employment_id,
                ev.secondary_manager_employment_id
           FROM employment_version ev
          WHERE ev.employment_id = e.id AND ${IN_EFFECT}) ev ON true
    LEFT JOIN LATERAL (
         SELECT ouv.name
           FROM org_unit_version ouv
          WHERE ouv.org_unit_id = ev.org_unit_id
            AND ouv.superseded_at IS NULL
            AND ouv.valid_from <= $2
            AND (ouv.valid_to IS NULL OR ouv.valid_to > $2)
          LIMIT 1) ou ON true
    LEFT JOIN LATERAL (
         SELECT coalesce(nullif(btrim(mp.preferred_name), ''), mp.legal_name) AS display_name
           FROM employment me JOIN person mp ON mp.id = me.person_id
          WHERE me.id = ev.manager_employment_id) mgr ON true
    LEFT JOIN LATERAL (
         SELECT coalesce(nullif(btrim(mp.preferred_name), ''), mp.legal_name) AS display_name
           FROM employment me JOIN person mp ON mp.id = me.person_id
          WHERE me.id = ev.secondary_manager_employment_id) mgr2 ON true
   WHERE e.id = $1`;

/**
 * REQ-002. Read inside a tenant transaction; row-level security scopes it.
 *
 * No `WHERE tenant_id = ?` anywhere. Application code that filters by tenant is
 * application code that will forget once, and once is the breach. Here,
 * forgetting returns zero rows.
 */
export async function readCurrentValues(
  tx: Tx,
  employmentId: string,
  asOf: BusinessDate,
): Promise<CurrentValues | null> {
  assertBusinessDate(asOf, 'asOf');
  const res = await tx.query(CURRENT_VALUES, [employmentId, asOf]);

  if ((res.rowCount ?? 0) > 1) {
    // REQ-002 in as many words: rather than show Aisha one of two possible
    // truths, fail loudly and alert. A screen that silently picks a row is a
    // screen that is wrong in a way nobody can see.
    throw new TemporalAmbiguityError(
      `Temporal integrity violation: ${res.rowCount} current rows for employment ${employmentId} on ${asOf}`,
    );
  }
  if ((res.rowCount ?? 0) === 0) return null;

  const r = res.rows[0];
  return {
    legalName: r.legal_name,
    preferredName: r.preferred_name ?? null,
    pronouns: r.pronouns ?? null,
    dateOfBirth: r.date_of_birth ?? null,
    personalEmail: r.personal_email ?? null,
    personalPhone: r.personal_phone ?? null,
    emergencyContact: r.emergency_contact ?? null,
    profilePhotoUrl: r.profile_photo_url ?? null,
    employeeNumber: r.employee_number,
    workEmail: r.work_email ?? null,
    hireDate: r.hire_date,
    exitDate: r.exit_date ?? null,
    status: r.status,
    jobTitle: r.job_title ?? null,
    team: r.team ?? null,
    managerName: r.manager_name ?? null,
    secondaryManagerName: r.secondary_manager_name ?? null,
    employmentType: r.employment_type ?? null,
    workLocation: r.work_location ?? null,
    asOf,
  };
}

// ---------------------------------------------------------------------------
// REQ-003 / REQ-004 — the change history
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  /** What changed, in the words recorded at the time. */
  what: string;
  /** When the decision was RECORDED. ISO instant; the caller formats it. */
  decidedAt: string;
  /**
   * Who decided, denormalised at write time.
   *
   * Read from `transparency_ledger.decided_by_name`, never joined to a live
   * employment row. That is the entire reason the column exists. A join would
   * return today's name, and nothing at all once the decider is erased — and
   * REQ-003 says the entry must still name somebody: "Former employee" if the
   * name was pseudonymised, the original name if it was not, and never blank
   * and never "Unknown".
   */
  decidedByName: string;
  /** Why, in the decider's own words. Rendered as TEXT, never as HTML. */
  reason: string;
  /** The business date the change takes effect. `null` for changes with no date. */
  effectiveFrom: string | null;
  /** REQ-004 — true when `effectiveFrom` is after the business date asked about. */
  future: boolean;
  /** RULE-008 — did she do this herself, or did somebody do it to her. */
  byHerself: boolean;
  /** Part 5 — a manager acting on the record of someone who manages them. */
  reciprocal: boolean;
  aiInvolved: boolean;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Opaque cursor for the next page, or `null` when this is the last one. */
  nextCursor: string | null;
}

/**
 * One page. Twenty-five entries, plus one row to find out whether more exist.
 *
 * `LIMIT 26` rather than a `COUNT(*)`: the count would be a second scan of an
 * unbounded set for a number nobody asked for, and REQ-019 forbids a total on
 * the neighbouring access log for a stronger reason. Cursor pagination keeps
 * the work bounded whether Aisha has three entries or three hundred (SCALE-02).
 */
export const HISTORY_PAGE_SIZE = 25;

/**
 * The read path Q-13 specified: render rows that no live successor points at.
 *
 * A correction appends a NEW ledger row carrying `supersedes_ledger_id`; the
 * original is never touched, so `REVOKE UPDATE` on the ledger stands. Filtering
 * here rather than in the template means a superseded row is not in scope to be
 * rendered, counted, or exported by accident.
 *
 * ORDERING, and REQ-004 is specific about it: future-dated changes sit ABOVE
 * today's entries, then everything by the date the decision was recorded,
 * newest first. `decided_at DESC, id DESC` — the id breaks ties, because two
 * decisions recorded in the same millisecond would otherwise page
 * non-deterministically and an entry could appear twice or never.
 */
const HISTORY = `
  SELECT l.id, l.what, l.decided_at, l.decided_by_name, l.reason,
         l.effective_from::text AS effective_from,
         l.decided_at::text     AS decided_at_text,
         l.reciprocal, l.ai_involved,
         (l.decided_by = $1)                                  AS by_herself,
         (l.effective_from IS NOT NULL AND l.effective_from > $2) AS future
    FROM transparency_ledger l
   WHERE l.subject_employment_id = $1
     AND NOT EXISTS (SELECT 1 FROM transparency_ledger s
                      WHERE s.supersedes_ledger_id = l.id)
     AND ($3::timestamptz IS NULL OR l.decided_at < $3)
   ORDER BY (l.effective_from IS NOT NULL AND l.effective_from > $2) DESC,
            l.decided_at DESC, l.id DESC
   LIMIT ${HISTORY_PAGE_SIZE + 1}`;

export async function readChangeHistory(
  tx: Tx,
  employmentId: string,
  asOf: BusinessDate,
  cursor: string | null = null,
): Promise<HistoryPage> {
  assertBusinessDate(asOf, 'asOf');

  const res = await tx.query(HISTORY, [employmentId, asOf, cursor]);
  const rows = res.rows.slice(0, HISTORY_PAGE_SIZE);
  const hasMore = res.rows.length > HISTORY_PAGE_SIZE;

  const entries: HistoryEntry[] = rows.map((r) => ({
    id: r.id,
    what: r.what,
    decidedAt: r.decided_at_text,
    // Never coalesced to "Unknown". The column is NOT NULL and erasure
    // pseudonymises it in place, so an empty string here would be a defect
    // worth seeing rather than papering over.
    decidedByName: r.decided_by_name,
    reason: r.reason,
    effectiveFrom: r.effective_from ?? null,
    future: r.future === true,
    byHerself: r.by_herself === true,
    reciprocal: r.reciprocal === true,
    aiInvolved: r.ai_involved === true,
  }));

  // Taken from the MAPPED entry, not the raw row. `rows` are snake_case from
  // PostgreSQL, so `rows[n].decidedAt` is `undefined` and the `?? null` swallowed
  // it — a cursor that was silently always null, which reads as "no more pages"
  // and would have truncated every long history at 25 entries with no error
  // anywhere. Found by seeding 30 rows and asserting a second page, which is
  // why the test seeds an overflow rather than asserting the constant.
  return {
    entries,
    nextCursor: hasMore ? (entries[entries.length - 1]?.decidedAt ?? null) : null,
  };
}

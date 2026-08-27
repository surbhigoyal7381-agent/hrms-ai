/**
 * "Who has looked at your record" — REQ-005, REQ-006, REQ-018, REQ-019,
 * REQ-020, RULE-004, RULE-005, RULE-006, RULE-007, RULE-010.
 *
 * This is the wow moment and the biggest employee-facing risk in the product,
 * in the same screen. Three properties carry that weight, and each one is a
 * place where a plausible implementation is wrong:
 *
 *   1. SUPPRESSED ENTRIES ARE FILTERED BEFORE GROUPING, never after. Confidential
 *      casework is not rendered (RULE-010). Group first and then remove, and
 *      Meera's "opened your record 3 times" silently becomes "2 times" — the
 *      count leaks the very thing the standing panel exists to hide. The filter
 *      lives in the `access_log_visible` view, so suppressed rows are not in
 *      scope to be counted in the first place.
 *
 *   2. AN ERASED VIEWER IS STILL A HUMAN READ. `actor_id` goes NULL when the
 *      person who looked is erased. If that were read as "a system did it",
 *      Aisha would be told no person read her record when one did — the most
 *      damaging false statement this screen can make. `actor_kind` is recorded
 *      at write time and erasure never touches it, so the classification cannot
 *      drift (RULE-005).
 *
 *   3. NO TOTAL IS EVER COMPUTED. Not displayed, and not calculated either — a
 *      bare count reads as surveillance, and `COUNT(*)` over a seven-year audit
 *      log is the unbounded query `SCALE-02` forbids. Paging is keyset, and
 *      "is there more" comes from fetching one row beyond the page.
 */
import type { Tx } from './db.js';
import { resolvePurpose, type PurposeCode } from './audit.js';

/** One rendered line. RULE-006 collapses repeats into a single entry. */
export interface AccessLogEntry {
  /** RULE-005. `human` even when the viewer has been erased. */
  kind: 'human' | 'system';
  /** The subject reading their own record — shown as "You", never hidden (Q-01). */
  isSelf: boolean;
  /**
   * The viewer's name as captured AT THE TIME OF THE READ, or 'Former employee'
   * once they are erased. `null` only for rows written before names were
   * captured, which render as an unnamed human read, never as a system read.
   */
  actorName: string | null;
  /** The role held on the day of the read — "HR Business Partner", not today's. */
  actorRoleLabel: string | null;
  /** For system reads: which job. */
  serviceName: string | null;
  /** Calendar day in the EMPLOYEE's work-calendar timezone. ISO, for the UI to format. */
  localDay: string;
  /** How many reads collapsed into this line. The UI states it only when > 1. */
  times: number;
  /** Most recent read in the group, for ordering and for the UI's time. */
  lastAt: string;
  /** RULE-004. `null` with `purposeMissing` when nothing maps. */
  purposeText: string | null;
  /** Drives "Reason not recorded" plus an alert — the entry is still shown. */
  purposeMissing: boolean;
  /** Carried so the caller can alert with the action name and no PII. */
  action: string;
}

export interface AccessLogPage {
  entries: AccessLogEntry[];
  /** Opaque keyset cursor. `null` when there is no further page. */
  nextCursor: string | null;
  /**
   * Bucketed, never exact (`access_log_viewed`). Derived from the page we
   * already fetched plus whether a next page exists — so no total is computed,
   * and the payload cannot be differenced to reveal a suppressed entry.
   */
  countBucket: '0' | '1-5' | '6-25' | '25+';
  /** RULE-007 — the caller states the window it is showing, never a longer one. */
  windowStartAt: string;
}

export const ACCESS_LOG_PAGE_SIZE = 25;

export interface AccessLogQuery {
  /** Whose record. Covers EVERY employment this person has had (REQ-018). */
  subjectPersonId: string;
  /** The employee's work-calendar timezone, e.g. 'Asia/Kolkata' (RULE-009). */
  timezone: string;
  /** RULE-007. The caller passes min(display window, actual audit retention). */
  windowDays: number;
  /** Keyset cursor from a previous page. */
  cursor?: string | null;
  pageSize?: number;
}

/**
 * The grouping key is `(actor identity, purpose, calendar day)` — RULE-006.
 *
 * "Purpose" is the RENDERED purpose, which is why the key is
 * `coalesce(purpose_code, 'action:' || action)` rather than `purpose_code`
 * alone. Two reads on the same day by the same person both showing
 * "annual pay review" are one line even if their `action` values differ; two
 * reads with NO purpose code and DIFFERENT actions render different sentences
 * and must not be collapsed into one line claiming they were the same thing.
 *
 * Grouping on `purpose_code` alone would merge the second case; grouping on
 * `action` as well would split the first. Neither is what RULE-006 describes.
 */
const GROUPED_ACCESS_LOG = `
  SELECT v.actor_kind,
         v.actor_id,
         v.actor_display_name,
         v.actor_role_label,
         v.service_name,
         min(v.purpose_code::text)                       AS purpose_code,
         min(v.action)                                   AS action,
         (v.at AT TIME ZONE $2)::date::text              AS local_day,
         count(*)::int                                   AS times,
         max(v.at)                                       AS last_at,
         -- "You" covers every employment the subject has ever held, so a read
         -- of a previous employment is still their own read (REQ-018).
         bool_or(ae.person_id IS NOT DISTINCT FROM $1)   AS is_self
    FROM access_log_visible v
    LEFT JOIN employment ae ON ae.id = v.actor_id
   WHERE v.subject_person_id = $1
     AND v.at >= $3::timestamptz
     AND ($4::timestamptz IS NULL OR v.at < $4::timestamptz)
   GROUP BY v.actor_kind, v.actor_id, v.actor_display_name, v.actor_role_label,
            v.service_name,
            coalesce(v.purpose_code::text, 'action:' || v.action),
            (v.at AT TIME ZONE $2)::date
   ORDER BY max(v.at) DESC
   LIMIT $5`;

/**
 * REQ-005 / REQ-019 — one page of the access log.
 *
 * Fetches `pageSize + 1` rows: the extra row answers "is there more" without a
 * `COUNT(*)`, which is both the product decision (no total-count badge) and the
 * `SCALE-02` requirement (no unbounded scan) satisfied by the same mechanism.
 */
export async function readAccessLog(
  tx: Tx,
  q: AccessLogQuery,
): Promise<AccessLogPage> {
  const pageSize = q.pageSize ?? ACCESS_LOG_PAGE_SIZE;
  const windowStart = new Date(Date.now() - q.windowDays * 86_400_000).toISOString();

  const res = await tx.query(GROUPED_ACCESS_LOG, [
    q.subjectPersonId,
    q.timezone,
    windowStart,
    q.cursor ?? null,
    pageSize + 1,
  ]);

  const rows = res.rows.slice(0, pageSize);
  const hasMore = res.rows.length > pageSize;

  const entries: AccessLogEntry[] = rows.map((r: any) => {
    const purpose = resolvePurpose(
      (r.purpose_code as PurposeCode | null) ?? null,
      r.action as string,
    );
    return {
      // Straight from the recorded column. Never inferred from a null actor id:
      // that inference is what would turn a human read into "only a computer".
      kind: r.actor_kind as 'human' | 'system',
      isSelf: r.is_self === true,
      actorName: r.actor_display_name ?? null,
      actorRoleLabel: r.actor_role_label ?? null,
      serviceName: r.service_name ?? null,
      localDay: r.local_day as string,
      times: r.times as number,
      lastAt: new Date(r.last_at).toISOString(),
      purposeText: purpose.text,
      purposeMissing: purpose.missing,
      action: r.action as string,
    };
  });

  return {
    entries,
    nextCursor: hasMore && entries.length > 0
      ? entries[entries.length - 1]!.lastAt
      : null,
    countBucket: bucketOf(entries.length, hasMore),
    windowStartAt: windowStart,
  };
}

/**
 * Buckets, never an exact count. Derived from the page in hand, so nothing has
 * to be counted across the whole log — and a payload that varied by one entry
 * could be differenced across two loads to reveal a suppressed read.
 */
function bucketOf(onPage: number, hasMore: boolean): AccessLogPage['countBucket'] {
  if (hasMore) return '25+';
  if (onPage === 0) return '0';
  if (onPage <= 5) return '1-5';
  return '6-25';
}

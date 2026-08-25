/**
 * The temporal model — RULE-001, RULE-002, RULE-003.
 *
 * Business time is a HALF-OPEN date interval [valid_from, valid_to).
 * Dates, not timestamps: a transfer effective 1 September is a business date,
 * and making it a timestamp introduces a timezone bug on every boundary.
 *
 * Versions are append-only. The only mutation permitted on an existing version
 * is closing `valid_to`.
 */

/** A business date: 'YYYY-MM-DD'. Never a Date object — those carry a timezone. */
export type BusinessDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertBusinessDate(d: string, field = 'date'): BusinessDate {
  if (!ISO_DATE.test(d)) {
    throw new ValidationError(`${field} must be a date in YYYY-MM-DD form, got "${d}"`, field);
  }
  // Reject impossible dates that match the shape, e.g. 2026-02-30.
  const parts = d.split('-').map(Number) as [number, number, number];
  const [y, m, day] = parts;
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ValidationError(`${field} is not a real date: "${d}"`, field);
  }
  return d;
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION';
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * RULE-002 — the point-in-time predicate, in TypeScript.
 *
 * The SQL form lives in exactly one place, `POINT_IN_TIME_PREDICATE` in
 * employment.ts, and every query interpolates it. A second, subtly different
 * copy is how this goes wrong: dropping the zero-length clause returns two rows
 * for one person and every downstream headcount doubles.
 */
export function isValidAt(
  version: { validFrom: BusinessDate; validTo: BusinessDate | null },
  asOf: BusinessDate,
): boolean {
  const { validFrom, validTo } = version;
  if (validFrom > asOf) return false;
  if (validTo === null) return true;
  if (validTo <= asOf) return false;
  // Zero-length (superseded) intervals are never current.
  if (validFrom >= validTo) return false;
  return true;
}

/**
 * Given the existing versions and a new effective date, work out what must
 * happen. Pure — no database, no clock — so the hard logic is unit-testable
 * without a container.
 */
export interface VersionRow {
  id: string;
  validFrom: BusinessDate;
  validTo: BusinessDate | null;
  recordedAt: string;
}

export interface ChangePlan {
  /** Version to close, and the date to close it at. */
  close: { id: string; validTo: BusinessDate } | null;
  /** The interval the new version will occupy. */
  insert: { validFrom: BusinessDate; validTo: BusinessDate | null };
  /** Versions left with a zero-length interval — historically superseded. */
  supersededIds: string[];
}

export function planChange(
  existing: VersionRow[],
  effectiveFrom: BusinessDate,
): ChangePlan {
  assertBusinessDate(effectiveFrom, 'effectiveFrom');

  const sorted = [...existing].sort((a, b) =>
    a.validFrom === b.validFrom
      ? a.recordedAt.localeCompare(b.recordedAt)
      : a.validFrom.localeCompare(b.validFrom),
  );

  // Live versions only: a zero-length interval is already superseded.
  const live = sorted.filter((v) => v.validTo === null || v.validFrom < v.validTo);

  // The version covering the effective date, if any.
  const covering = live.find((v) => isValidAt(v, effectiveFrom));

  // Anything starting on or after the effective date is superseded by this change.
  const superseded = live.filter((v) => v.validFrom >= effectiveFrom && v.id !== covering?.id);

  // The new version runs until the next surviving version begins, or forever.
  const nextStart = live
    .filter((v) => v.validFrom > effectiveFrom && !superseded.some((s) => s.id === v.id))
    .map((v) => v.validFrom)
    .sort()[0] ?? null;

  return {
    close: covering ? { id: covering.id, validTo: effectiveFrom } : null,
    insert: { validFrom: effectiveFrom, validTo: nextStart },
    supersededIds: superseded.map((v) => v.id),
  };
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { freshDatabase, adminPool, seedTenant, type SeededTenant } from './setup.js';
import { withTenantForResolution } from '../src/db.js';
import { readCurrentValues, readChangeHistory } from '../src/record-view.js';

/**
 * REQ-002, REQ-003, REQ-004 — what Aisha sees.
 *
 * Against a real PostgreSQL 16, through the application role, with row-level
 * security on. A read model tested against mocks proves the TypeScript is
 * self-consistent and nothing about whether the SQL is right, which is where
 * every bug in a bitemporal query lives.
 */

const DB = 'hrms_record_view_test';
const TODAY = '2026-08-26';

let app: pg.Pool;
let admin: pg.Pool;
let northwind: SeededTenant;
let contoso: SeededTenant;

/** Runs as the OWNER — this is provisioning and HR activity, not a request. */
async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>, tenantId: string): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    return await fn(c);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  northwind = await seedTenant(admin, { name: 'Northwind', region: 'eu' });
  contoso = await seedTenant(admin, { name: 'Contoso', region: 'in' });

  await asOwner(async (c) => {
    // Aisha's personal details, so the read model has something to return.
    await c.query(
      `UPDATE person SET pronouns = 'she/her', date_of_birth = '1996-04-11',
              personal_phone = '+91 98200 11223', personal_email = 'aisha@example.com',
              emergency_contact = 'Ravi Sharma +91 98200 44556',
              national_id_ref = 'THIS-MUST-NEVER-REACH-A-SCREEN'
        WHERE id = $1`,
      [northwind.personId]);

    // The ledger entries REQ-003 and REQ-004 are about. Written directly:
    // `applyEmploymentChange` is feature 001's and is tested there; what is
    // under test here is the READ.
    await c.query(
      `INSERT INTO transparency_ledger
         (tenant_id, subject_employment_id, what, decided_by, decided_by_name,
          decided_at, reason, effective_from)
       VALUES
         ($1, $2, 'Changed team', $3, 'Rohan Mehta',
          '2026-08-22T14:32:00+05:30', 'Moving to Payments to lead the settlements work',
          '2026-09-01'),
         ($1, $2, 'Changed job title', $3, 'Rohan Mehta',
          '2026-07-02T10:00:00+05:30', 'Promotion to Senior Engineer', '2026-07-01'),
         ($1, $2, 'Corrected personal phone', $4, 'Aisha Khan',
          '2026-06-15T09:00:00+05:30', 'I updated my own phone number', NULL)`,
      [northwind.tenantId, northwind.employmentId, northwind.hrEmploymentId,
       northwind.employmentId]);
  }, northwind.tenantId);
}, 60_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

const read = <T>(tenantId: string, fn: Parameters<typeof withTenantForResolution<T>>[2]) =>
  withTenantForResolution(app, tenantId, fn);

describe('REQ-002 — current values', () => {
  it('returns what the company holds about Aisha today', async () => {
    const values = await read(northwind.tenantId, (tx) =>
      readCurrentValues(tx, northwind.employmentId, TODAY));

    expect(values).not.toBeNull();
    expect(values!.legalName).toBe('Aisha Kumar');
    expect(values!.pronouns).toBe('she/her');
    expect(values!.personalPhone).toBe('+91 98200 11223');
    expect(values!.employeeNumber).toBeTruthy();
    expect(values!.hireDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(values!.jobTitle).toBeTruthy();
    expect(values!.team).toBeTruthy();
    expect(values!.asOf).toBe(TODAY);
  });

  it('NEVER returns the national identifier, under any key', async () => {
    // The PM's ruling of 2026-08-26. The fixture writes a sentinel into the
    // column, so this is not vacuous: if the read model selected it, the string
    // would be here. Asserted over the whole serialised object rather than a
    // named field, so a future `SELECT p.*` is caught too.
    const owner = await asOwner(
      (c) => c.query(`SELECT national_id_ref FROM person WHERE id = $1`, [northwind.personId]),
      northwind.tenantId);
    expect(owner.rows[0].national_id_ref, 'the fixture did not seed the sentinel')
      .toBe('THIS-MUST-NEVER-REACH-A-SCREEN');

    const values = await read(northwind.tenantId, (tx) =>
      readCurrentValues(tx, northwind.employmentId, TODAY));

    expect(JSON.stringify(values)).not.toContain('THIS-MUST-NEVER-REACH-A-SCREEN');
    expect(JSON.stringify(values)).not.toContain('national');
    expect(Object.keys(values!)).not.toContain('nationalId');
  });

  it('does not name the column in the query text either', async () => {
    // Belt to the braces above. The behavioural test would still pass if the
    // column were fetched and then dropped in the mapping — and a fetched
    // column can reach a log, an error page or a `console.log` in a hurry.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/record-view.ts', import.meta.url), 'utf8'));
    const sql = source.split('\n').filter((l) => !l.trimStart().startsWith('*'));
    expect(sql.join('\n')).not.toMatch(/national_id_ref/);
  });

  it('resolves values as at the date asked for, not as at today', async () => {
    // REQ-002's temporal criterion. A future change must NOT appear in the
    // current values — a value that is not yet true must not look true.
    const version = await asOwner((c) => c.query(
      `SELECT job_title, valid_from::text AS valid_from FROM employment_version
        WHERE employment_id = $1 AND superseded_at IS NULL
        ORDER BY valid_from LIMIT 1`, [northwind.employmentId]), northwind.tenantId);
    const firstFrom: string = version.rows[0].valid_from;

    const dayBefore = new Date(Date.parse(firstFrom) - 86_400_000)
      .toISOString().slice(0, 10);
    const before = await read(northwind.tenantId, (tx) =>
      readCurrentValues(tx, northwind.employmentId, dayBefore));

    // The employment row exists on that date; the effective-dated attributes
    // do not. `null` is the honest answer, and the screen says "not set yet".
    expect(before).not.toBeNull();
    expect(before!.jobTitle).toBeNull();
    expect(before!.team).toBeNull();
  });

  it('returns nothing for another tenant`s employment', async () => {
    // SEC-02. Row-level security, not a WHERE clause the read model remembers.
    const values = await read(contoso.tenantId, (tx) =>
      readCurrentValues(tx, northwind.employmentId, TODAY));
    expect(values).toBeNull();
  });

  it('refuses anything that is not a business date', async () => {
    await expect(
      read(northwind.tenantId, (tx) =>
        readCurrentValues(tx, northwind.employmentId, '2026-08-26T00:00:00Z')),
    ).rejects.toThrow(/business date/i);
  });
});

describe('REQ-003 — every change, with the reason and the decider', () => {
  it('returns the entries with what, when, who and why', async () => {
    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));

    expect(page.entries.length).toBe(3);
    const teamChange = page.entries.find((e) => e.what === 'Changed team');
    expect(teamChange).toBeDefined();
    expect(teamChange!.decidedByName).toBe('Rohan Mehta');
    // Her own words, verbatim. The reason is the whole point of REQ-003 — a
    // history of what changed without why is a changelog, not transparency.
    expect(teamChange!.reason).toBe('Moving to Payments to lead the settlements work');
    expect(teamChange!.effectiveFrom).toBe('2026-09-01');
    expect(teamChange!.decidedAt).toContain('2026-08-22');
  });

  it('orders by the date the decision was RECORDED, newest first', async () => {
    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));

    const nonFuture = page.entries.filter((e) => !e.future).map((e) => e.decidedAt);
    const sorted = [...nonFuture].sort().reverse();
    expect(nonFuture).toEqual(sorted);
  });

  it('says plainly whether Aisha did it herself or somebody did it to her', async () => {
    // RULE-008. Both cases exist in the fixture, so neither branch is vacuous.
    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));

    const byHer = page.entries.filter((e) => e.byHerself);
    const byOthers = page.entries.filter((e) => !e.byHerself);
    expect(byHer.map((e) => e.what)).toEqual(['Corrected personal phone']);
    expect(byOthers.length).toBe(2);
  });

  it('still names the decider after that person is erased', async () => {
    // REQ-003's hardest criterion, and the reason `decided_by_name` is
    // denormalised. Erasure pseudonymises the NAME in place; a read model that
    // joined to a live employment row would return nothing here and the entry
    // would render blank — the one thing the requirement forbids.
    await asOwner((c) => c.query(
      `UPDATE transparency_ledger SET decided_by_name = 'Former employee'
        WHERE subject_employment_id = $1 AND what = 'Changed job title'`,
      [northwind.employmentId]), northwind.tenantId);

    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));
    const entry = page.entries.find((e) => e.what === 'Changed job title')!;

    expect(entry.decidedByName).toBe('Former employee');
    expect(entry.decidedByName).not.toBe('');
    expect(entry.decidedByName.toLowerCase()).not.toContain('unknown');
    // The reason survives the erasure, so the entry still explains itself.
    expect(entry.reason).toBe('Promotion to Senior Engineer');

    // Put it back, so the ordering tests above do not depend on run order.
    await asOwner((c) => c.query(
      `UPDATE transparency_ledger SET decided_by_name = 'Rohan Mehta'
        WHERE subject_employment_id = $1 AND what = 'Changed job title'`,
      [northwind.employmentId]), northwind.tenantId);
  });

  it('returns an empty page, not an error, when there is no history', async () => {
    const page = await read(contoso.tenantId, (tx) =>
      readChangeHistory(tx, contoso.employmentId, TODAY));
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('shows a corrected entry and hides the one it replaced', async () => {
    // Q-13's read path. A correction APPENDS a row pointing back at the
    // original; the original is never touched, so `REVOKE UPDATE` stands.
    const original = await asOwner((c) => c.query(
      `SELECT id FROM transparency_ledger
        WHERE subject_employment_id = $1 AND what = 'Changed team'`,
      [northwind.employmentId]), northwind.tenantId);
    const originalId: string = original.rows[0].id;

    await asOwner((c) => c.query(
      `INSERT INTO transparency_ledger
         (tenant_id, subject_employment_id, what, decided_by, decided_by_name,
          decided_at, reason, effective_from, supersedes_ledger_id)
       VALUES ($1,$2,'Changed team',$3,'Meera Iyer','2026-08-26T11:00:00+05:30',
               'Moving you off settlements while a process is under way',
               '2026-09-01',$4)`,
      [northwind.tenantId, northwind.employmentId, northwind.hrEmploymentId, originalId]),
      northwind.tenantId);

    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));

    const teamEntries = page.entries.filter((e) => e.what === 'Changed team');
    expect(teamEntries).toHaveLength(1);
    expect(teamEntries[0]!.reason)
      .toBe('Moving you off settlements while a process is under way');
    expect(page.entries.map((e) => e.id)).not.toContain(originalId);

    // The original still EXISTS — append-only. Confirmed through the owner,
    // because the read model is exactly what is hiding it.
    const stillThere = await asOwner((c) => c.query(
      `SELECT count(*)::int AS n FROM transparency_ledger WHERE id = $1`, [originalId]),
      northwind.tenantId);
    expect(stillThere.rows[0].n).toBe(1);
  });
});

describe('REQ-004 — a change that has not happened yet', () => {
  it('shows the future-dated change, flagged, at the top', async () => {
    // The human ruled on 2026-08-26: nothing is hidden, no delay window, no
    // per-change suppression. The case that decided it was an exit date — a
    // company that has written one has decided, and she gets to know.
    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));

    const future = page.entries.filter((e) => e.future);
    expect(future.length).toBeGreaterThan(0);
    expect(future[0]!.effectiveFrom).toBe('2026-09-01');
    // Above today's entries, per REQ-004.
    expect(page.entries[0]!.future).toBe(true);
    // And it is a labelled flag, not a colour — the label is the caller's to
    // render, but the data it renders from must be here (A11Y-04).
    expect(page.entries[0]!.effectiveFrom).not.toBeNull();
  });

  it('stops calling it future once the effective date arrives', async () => {
    // The same row, read on a later business date, is simply history. If this
    // were computed from `new Date()` inside the read model, it could not be
    // tested at all without waiting five days.
    const page = await read(northwind.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, '2026-09-02'));
    expect(page.entries.every((e) => !e.future)).toBe(true);
  });

  it('is bounded — one page, with a cursor, never the whole history', async () => {
    // SCALE-02 and PERF-01. Asserted against a real overflow rather than
    // against the constant: 30 rows seeded, 25 returned, a cursor issued.
    await asOwner(async (c) => {
      for (let i = 0; i < 30; i += 1) {
        await c.query(
          `INSERT INTO transparency_ledger
             (tenant_id, subject_employment_id, what, decided_by, decided_by_name,
              decided_at, reason)
           VALUES ($1,$2,$3,$4,'Meera Iyer', $5, 'Bulk fixture row')`,
          [contoso.tenantId, contoso.employmentId, `Change ${i}`, contoso.hrEmploymentId,
           new Date(Date.UTC(2026, 0, i + 1)).toISOString()]);
      }
    }, contoso.tenantId);

    const first = await read(contoso.tenantId, (tx) =>
      readChangeHistory(tx, contoso.employmentId, TODAY));
    expect(first.entries).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();

    const second = await read(contoso.tenantId, (tx) =>
      readChangeHistory(tx, contoso.employmentId, TODAY, first.nextCursor));
    expect(second.entries.length).toBe(5);
    expect(second.nextCursor).toBeNull();

    // No entry appears on both pages — the ordering is total, so paging is
    // deterministic. A tie on `decided_at` without the id tiebreak would show
    // a row twice or skip it, and nobody would notice for months.
    const firstIds = new Set(first.entries.map((e) => e.id));
    expect(second.entries.some((e) => firstIds.has(e.id))).toBe(false);
  });

  it('does not leak another tenant`s history', async () => {
    const page = await read(contoso.tenantId, (tx) =>
      readChangeHistory(tx, northwind.employmentId, TODAY));
    expect(page.entries).toEqual([]);
  });
});

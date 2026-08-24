import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant } from './setup.js';
import { withTenant } from '../src/db.js';
import {
  applyEmploymentChange, employmentAsOf, employmentAsKnownAt, headcountAsOf,
  redact, SELF_CORRECTABLE,
} from '../src/employment.js';
import { ValidationError } from '../src/temporal.js';
import { ForbiddenError, type Principal } from '../src/policy.js';

/** REQ-002..REQ-006, RULE-001..RULE-003. Written from the requirements. */
const DB = 'hrms_employment_test';

let app: pg.Pool;
let admin: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
let payments: string;

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Acme', region: 'eu' });
  const c = await admin.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
  const r = await c.query(
    `INSERT INTO org_unit (tenant_id, code) VALUES ($1,'PAY') RETURNING id`, [A.tenantId]);
  payments = r.rows[0].id;
  await c.query(
    `INSERT INTO org_unit_version (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
     VALUES ($1,$2,'Payments','2020-01-01',$3,'Initial org setup')`,
    [A.tenantId, payments, A.hrId]);
  c.release();
}, 60_000);

afterAll(async () => { await app?.end(); await admin?.end(); });

const actor = () => ({ tenantId: A.tenantId, actorId: A.hrId });

/** HR admin with no employment of their own — the common case for a Meera. */
const hr = (): Principal => ({
  tenantId: A.tenantId, actorId: A.hrId,
  employmentId: null, roles: new Set(['hr_admin' as const]),
});

describe('REQ-003 — effective-dated change', () => {
  it('the transfer from the requirements produces the exact table shown there', async () => {
    await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, hr(), {
        employmentId: A.employmentId,
        effectiveFrom: '2026-09-01',
        reason: 'Moving to Payments to lead the settlements work',
        decidedByName: 'Rohan Mehta',
        attributes: { orgUnitId: payments },
      }));

    // The SYSTEM-LIVE view is the table from the requirements.
    const live = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT valid_from::text AS f, valid_to::text AS t, org_unit_id
           FROM employment_version
          WHERE employment_id = $1 AND superseded_at IS NULL
          ORDER BY valid_from`, [A.employmentId]);
      return r.rows;
    });
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject({ f: '2023-04-12', t: '2026-09-01', org_unit_id: A.orgUnitId });
    expect(live[1]).toMatchObject({ f: '2026-09-01', t: null, org_unit_id: payments });

    // And the ORIGINAL row survives untouched, still open-ended. This is what
    // makes "what did we believe before the transfer" answerable, and it is
    // exactly what overwriting valid_to in place used to destroy.
    const history = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT valid_from::text AS f, valid_to::text AS t
           FROM employment_version
          WHERE employment_id = $1 AND superseded_at IS NOT NULL`, [A.employmentId]);
      return r.rows;
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ f: '2023-04-12', t: null });
  });

  it('REQ-004 — point-in-time: Engineering on 31 Aug, Payments on 1 Sept', async () => {
    const aug = await withTenant(app, actor(), (tx) => employmentAsOf(tx, A.employmentId, '2026-08-31'));
    const sep = await withTenant(app, actor(), (tx) => employmentAsOf(tx, A.employmentId, '2026-09-01'));
    expect(aug?.org_unit_id).toBe(A.orgUnitId);
    expect(sep?.org_unit_id).toBe(payments);
  });

  it('REQ-004 — headcount counts the person exactly once, in one org unit', async () => {
    const engAug = await withTenant(app, actor(), (tx) => headcountAsOf(tx, A.orgUnitId, '2026-08-31'));
    const payAug = await withTenant(app, actor(), (tx) => headcountAsOf(tx, payments, '2026-08-31'));
    const engSep = await withTenant(app, actor(), (tx) => headcountAsOf(tx, A.orgUnitId, '2026-09-01'));
    const paySep = await withTenant(app, actor(), (tx) => headcountAsOf(tx, payments, '2026-09-01'));
    expect([engAug, payAug]).toEqual([1, 0]);
    expect([engSep, paySep]).toEqual([0, 1]);
  });

  it('writes the transparency ledger in the SAME transaction as the change', async () => {
    const ledger = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT what, reason, decided_by_name, effective_from::text AS eff, ai_involved
           FROM transparency_ledger WHERE subject_employment_id = $1`, [A.employmentId]);
      return r.rows;
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe('Moving to Payments to lead the settlements work');
    expect(ledger[0].decided_by_name).toBe('Rohan Mehta');
    expect(ledger[0].eff).toBe('2026-09-01');
    expect(ledger[0].ai_involved).toBe(false);
  });

  it('refuses a change with an empty reason', async () => {
    await expect(
      withTenant(app, actor(), (tx) =>
        applyEmploymentChange(tx, hr(), {
          employmentId: A.employmentId, effectiveFrom: '2026-10-01',
          reason: '   ', decidedByName: 'Rohan Mehta',
          attributes: { jobTitle: 'Senior Engineer' },
        })),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an effective date before the hire date', async () => {
    await expect(
      withTenant(app, actor(), (tx) =>
        applyEmploymentChange(tx, hr(), {
          employmentId: A.employmentId, effectiveFrom: '2020-01-01',
          reason: 'Backdated too far', decidedByName: 'Rohan Mehta',
          attributes: { jobTitle: 'Engineer' },
        })),
    ).rejects.toThrow(/before the hire date/);
  });

  it('REL-03 — a double-tap creates exactly one version', async () => {
    const key = 'idem-double-tap-1';
    const first = await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, hr(), {
        employmentId: A.employmentId, effectiveFrom: '2026-11-01',
        reason: 'Promotion to Senior', decidedByName: 'Rohan Mehta',
        attributes: { jobTitle: 'Senior Engineer' }, idempotencyKey: key,
      }));
    const second = await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, hr(), {
        employmentId: A.employmentId, effectiveFrom: '2026-11-01',
        reason: 'Promotion to Senior', decidedByName: 'Rohan Mehta',
        attributes: { jobTitle: 'Senior Engineer' }, idempotencyKey: key,
      }));
    expect(second.versionId).toBe(first.versionId);

    const n = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT count(*)::int AS n FROM employment_version
          WHERE employment_id = $1 AND idempotency_key = $2`, [A.employmentId, key]);
      return r.rows[0].n;
    });
    expect(n).toBe(1);
  });
});

describe('RULE-001 — the retroactive change ("the nasty one")', () => {
  it('supersedes the future version and never returns two current rows', async () => {
    // Aisha's transfer was recorded for 1 Sept. On 15 Sept HR is told it
    // actually happened on 15 Aug.
    await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, hr(), {
        employmentId: A.employmentId, effectiveFrom: '2026-08-15',
        reason: 'Correction: the transfer actually took effect on 15 August',
        decidedByName: 'Meera Iyer', attributes: { orgUnitId: payments },
      }));

    // The superseded row survives for the audit trail, with its ORIGINAL
    // interval intact — that is the whole point of the system-time fix.
    const superseded = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT count(*)::int AS n FROM employment_version
          WHERE employment_id = $1 AND superseded_at IS NOT NULL`, [A.employmentId]);
      return r.rows[0].n;
    });
    expect(superseded).toBeGreaterThan(0);

    // ...but is never returned by a point-in-time query. This is the assertion
    // that protects every downstream headcount from double-counting.
    for (const d of ['2026-08-14', '2026-08-15', '2026-08-31', '2026-09-01', '2026-09-02']) {
      const rows = await withTenant(app, actor(), async (tx) => {
        const r = await tx.query(
          `SELECT id FROM employment_version
            WHERE employment_id = $1 AND superseded_at IS NULL
              AND valid_from <= $2
              AND (valid_to IS NULL OR valid_to > $2)
              AND (valid_to IS NULL OR valid_from < valid_to)`, [A.employmentId, d]);
        return r.rows;
      });
      expect(rows, `exactly one current version on ${d}`).toHaveLength(1);
    }
  });

  it('now reports Payments on 15 Aug, where it reported Engineering before', async () => {
    const v = await withTenant(app, actor(), (tx) => employmentAsOf(tx, A.employmentId, '2026-08-15'));
    expect(v?.org_unit_id).toBe(payments);
  });
});

describe('the database refuses overlapping versions', () => {
  it('rejects a hand-crafted overlapping insert with an exclusion violation', async () => {
    // Application logic prevents this; the constraint is the last line of
    // defence against a concurrency race.
    await expect(
      withTenant(app, actor(), async (tx) => {
        await tx.query(
          `INSERT INTO employment_version
             (tenant_id, employment_id, valid_from, valid_to, org_unit_id,
              job_title, employment_type, decided_by, reason)
           VALUES ($1,$2,'2024-01-01','2025-01-01',$3,'Engineer','full_time',$4,'overlap')`,
          [A.tenantId, A.employmentId, A.orgUnitId, A.hrId]);
      }),
    ).rejects.toThrow(/conflicting key value violates exclusion constraint/i);
  });
});

describe('PRIV-07 — PII never reaches the audit payload', () => {
  it('redacts identity fields', () => {
    const out = redact({
      legal_name: 'Aisha Kumar',
      national_id_ref: 'ABCDE1234F',
      personal_email: 'aisha@example.com',
      personal_phone: '+911234567890',
      date_of_birth: '1994-03-02',
      job_title: 'Engineer',
    });
    expect(out.national_id_ref).toBe('[REDACTED]');
    expect(out.personal_email).toBe('[REDACTED]');
    expect(out.personal_phone).toBe('[REDACTED]');
    expect(out.date_of_birth).toBe('[REDACTED]');
    expect(out.job_title).toBe('Engineer');
  });

  it('no audit row contains a known PII string', async () => {
    const hits = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE before_data::text LIKE '%aisha@example.com%'
             OR after_data::text  LIKE '%aisha@example.com%'`);
      return r.rows[0].n;
    });
    expect(hits).toBe(0);
  });
});

describe('REQ-006 — the self-correctable allowlist', () => {
  it('contains only factual personal fields, never job, pay, manager or dates', () => {
    expect([...SELF_CORRECTABLE].sort()).toEqual(
      ['personal_email', 'personal_phone', 'preferred_name', 'pronouns']);
    for (const forbidden of ['job_title', 'org_unit_id', 'manager_employment_id',
                             'hire_date', 'exit_date', 'salary_band', 'employee_number']) {
      expect(SELF_CORRECTABLE as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('COMP-01 — every personal-data column is classified', () => {
  it('has no unclassified column in the personal-data tables', async () => {
    // This is the check that becomes a CI gate (COMP-34).
    const missing = await admin.query(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         LEFT JOIN data_classification dc
           ON dc.table_name = c.table_name AND dc.column_name = c.column_name
        WHERE c.table_schema = 'public'
          AND c.table_name IN ('person')
          AND c.column_name NOT IN ('id','tenant_id','created_at','updated_at')
          AND dc.column_name IS NULL`);
    expect(missing.rows).toEqual([]);
  });
});

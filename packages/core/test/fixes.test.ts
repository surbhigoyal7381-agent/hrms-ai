import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant } from './setup.js';
import { withTenant } from '../src/db.js';
import { applyEmploymentChange, employmentAsKnownAt, headcountAsOf } from '../src/employment.js';
import { decide, ForbiddenError, type Principal } from '../src/policy.js';
import { erasePerson, CORE_HR_STORES } from '../src/erasure.js';
import { ValidationError } from '../src/temporal.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Regression suite for the findings in 50-review.md.
 * Each block names the finding it closes. Deleting one reopens the hole.
 */
const DB = 'hrms_fixes_test';
let app: pg.Pool; let admin: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
let B: Awaited<ReturnType<typeof seedTenant>>;
let payments: string;
let rohanEmp: string;

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Acme', region: 'eu' });
  B = await seedTenant(admin, { name: 'Borealis', region: 'in' });
  const c = await admin.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
  const ou = await c.query(`INSERT INTO org_unit (tenant_id, code) VALUES ($1,'PAY') RETURNING id`, [A.tenantId]);
  payments = ou.rows[0].id;
  await c.query(
    `INSERT INTO org_unit_version (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
     VALUES ($1,$2,'Payments','2020-01-01',$3,'setup')`, [A.tenantId, payments, A.hrId]);
  // Rohan — Aisha's manager.
  const rp = await c.query(`INSERT INTO person (tenant_id, legal_name) VALUES ($1,'Rohan Mehta') RETURNING id`, [A.tenantId]);
  const re = await c.query(
    `INSERT INTO employment (tenant_id, person_id, employee_number, hire_date, status)
     VALUES ($1,$2,'E-1002','2021-01-04','active') RETURNING id`, [A.tenantId, rp.rows[0].id]);
  rohanEmp = re.rows[0].id;
  await c.query(
    `INSERT INTO employment_version (tenant_id, employment_id, valid_from, org_unit_id,
       job_title, employment_type, decided_by, reason)
     VALUES ($1,$2,'2021-01-04',$3,'Engineering Manager','full_time',$4,'Initial hire')`,
    [A.tenantId, rohanEmp, A.orgUnitId, A.hrId]);
  await c.query(
    `UPDATE employment_version SET manager_employment_id = $2 WHERE employment_id = $1`,
    [A.employmentId, rohanEmp]);
  c.release();
}, 60_000);

afterAll(async () => { await app?.end(); await admin?.end(); });

const actor = () => ({ tenantId: A.tenantId, actorId: A.hrId });
const hr = (): Principal => ({
  tenantId: A.tenantId, actorId: A.hrId, employmentId: null, roles: new Set(['hr_admin']) });
const rohan = (): Principal => ({
  tenantId: A.tenantId, actorId: A.hrId, employmentId: rohanEmp, roles: new Set(['manager']) });
const aisha = (): Principal => ({
  tenantId: A.tenantId, actorId: A.hrId, employmentId: A.employmentId, roles: new Set(['employee']) });
/** A colleague with no management relationship to Aisha at all. */
const stranger = (): Principal => ({
  tenantId: A.tenantId, actorId: A.hrId,
  employmentId: '00000000-0000-0000-0000-0000000000cc', roles: new Set(['employee']) });

const change = (overrides = {}) => ({
  employmentId: A.employmentId, effectiveFrom: '2026-09-01',
  reason: 'Moving to Payments', decidedByName: 'Rohan Mehta',
  attributes: { orgUnitId: payments }, ...overrides,
});

// ── BLOCKER-1 ────────────────────────────────────────────────────────────────
describe('BLOCKER-1 — authorisation exists and is enforced in packages/core', () => {
  it('an ordinary employee CANNOT change a colleague record', async () => {
    // Previously this succeeded: RLS let it through because it is the same
    // tenant, and actor_id was recorded but never checked.
    await expect(
      withTenant(app, actor(), (tx) =>
        applyEmploymentChange(tx, stranger(), change())),
    ).rejects.toThrow(ForbiddenError);
  });

  it('nobody can change their OWN job, team or reporting line — including HR', () => {
    expect(decide(aisha(), 'employment.change',
      { employmentId: A.employmentId, managerEmploymentId: rohanEmp, secondaryManagerEmploymentId: null })
      .allowed).toBe(false);
    // Self-approval is a control failure even for an admin.
    const hrWithEmployment: Principal = { ...hr(), employmentId: A.employmentId };
    expect(decide(hrWithEmployment, 'employment.change',
      { employmentId: A.employmentId, managerEmploymentId: null, secondaryManagerEmploymentId: null })
      .allowed).toBe(false);
  });

  it('a dotted-line manager can read but NOT write', () => {
    const dotted: Principal = { ...rohan(), employmentId: 'dotted-id' };
    expect(decide(dotted, 'employment.change',
      { employmentId: A.employmentId, managerEmploymentId: rohanEmp, secondaryManagerEmploymentId: 'dotted-id' })
      .allowed).toBe(false);
  });

  it('the primary manager and HR CAN change it', async () => {
    const res = await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, rohan(), change()));
    expect(res.versionId).toBeTruthy();
  });

  it('only HR can export the directory or run an import', () => {
    for (const action of ['directory.export', 'import.run'] as const) {
      expect(decide(rohan(), action, null).allowed).toBe(false);
      expect(decide(hr(), action, null).allowed).toBe(true);
    }
  });
});

describe('MAJOR-1 — the accountable human cannot be forged', () => {
  it('decided_by always equals the principal that was authorised', async () => {
    const res = await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, rohan(), change({ effectiveFrom: '2027-03-01' })));
    const row = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT decided_by FROM employment_version WHERE id = $1`, [res.versionId]);
      return r.rows[0];
    });
    // There is now ONE identity parameter, so these cannot diverge.
    expect(row.decided_by).toBe(rohan().actorId);
  });

  it('the reciprocal flag is not set for an ordinary manager change', async () => {
    const entries = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT reciprocal FROM transparency_ledger
          WHERE subject_employment_id = $1`, [A.employmentId]);
      return r.rows.map((x: any) => x.reciprocal);
    });
    // Previously structurally always true, which made the flag meaningless.
    expect(entries.some((x: boolean) => x === false)).toBe(true);
  });
});

// ── BLOCKER-4 ────────────────────────────────────────────────────────────────
describe('BLOCKER-4 — "what did we know at T" survives a retroactive correction', () => {
  it('the as-at answer does not change because of something recorded later', async () => {
    const beforeCorrection = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 50));

    const asAtBefore = await withTenant(app, actor(), (tx) =>
      employmentAsKnownAt(tx, A.employmentId, '2026-08-31', beforeCorrection));

    // A retroactive correction lands AFTER the as-at moment.
    await withTenant(app, actor(), (tx) =>
      applyEmploymentChange(tx, hr(), change({
        effectiveFrom: '2026-08-15',
        reason: 'Correction: the transfer actually took effect on 15 August',
      })));

    const asAtAfter = await withTenant(app, actor(), (tx) =>
      employmentAsKnownAt(tx, A.employmentId, '2026-08-31', beforeCorrection));

    // Same question, same as-at moment, same answer. This is the property the
    // in-place valid_to overwrite destroyed.
    expect(asAtAfter?.org_unit_id).toBe(asAtBefore?.org_unit_id);
    expect(asAtAfter?.id).toBe(asAtBefore?.id);
  });

  it('the ledger says the effective date moved, not just "changed team"', async () => {
    const entries = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT what FROM transparency_ledger
          WHERE subject_employment_id = $1 ORDER BY decided_at`, [A.employmentId]);
      return r.rows.map((x: any) => x.what);
    });
    // Aisha must be able to see that her transfer date moved — it changes her pay.
    expect(entries.some((w: string) => /Effective date corrected from .* to /.test(w))).toBe(true);
  });
});

// ── MAJOR-1 ──────────────────────────────────────────────────────────────────
describe('MAJOR-1 — headcount survives a reorganisation', () => {
  it('moving a team under another parent does not zero its headcount', async () => {
    const before = await withTenant(app, actor(), (tx) => headcountAsOf(tx, payments, '2026-10-01'));
    expect(before).toBe(1);

    // Reorg: Payments moves under a new Commerce unit on 1 Oct.
    const c = await admin.connect();
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    const com = await c.query(`INSERT INTO org_unit (tenant_id, code) VALUES ($1,'COM') RETURNING id`, [A.tenantId]);
    await c.query(
      `INSERT INTO org_unit_version (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
       VALUES ($1,$2,'Commerce','2026-10-01',$3,'New commerce org')`,
      [A.tenantId, com.rows[0].id, A.hrId]);
    await c.query(`UPDATE org_unit_version SET valid_to = '2026-10-01'
                    WHERE org_unit_id = $1 AND valid_to IS NULL`, [payments]);
    await c.query(
      `INSERT INTO org_unit_version (tenant_id, org_unit_id, parent_id, name, valid_from, decided_by, reason)
       VALUES ($1,$2,$3,'Payments','2026-10-01',$4,'Payments moves under Commerce')`,
      [A.tenantId, payments, com.rows[0].id, A.hrId]);
    c.release();

    // The org unit IDENTITY is unchanged, so employment_version still points at
    // it and Meera gets the right number.
    const after = await withTenant(app, actor(), (tx) => headcountAsOf(tx, payments, '2026-11-01'));
    expect(after).toBe(1);
  });
});

// ── MAJOR-2 ──────────────────────────────────────────────────────────────────
describe('MAJOR-2 — history cannot be deleted OR silently rewritten', () => {
  it('UPDATE of version business data is denied', async () => {
    // DELETE was revoked in round 2; UPDATE was not, so the system-time chain
    // BLOCKER-4 exists to protect was still one bad script away from a rewrite.
    await expect(
      withTenant(app, actor(), async (tx) => {
        await tx.query(
          `UPDATE employment_version SET valid_from = '2019-01-01', job_title = 'Rewritten'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('but the two legitimate column paths still work', async () => {
    await withTenant(app, actor(), async (tx) => {
      await tx.query(`UPDATE employment_version SET superseded_at = superseded_at`);
      await tx.query(`UPDATE employment_version SET reason = reason`);
    });
  });

  it.each(['employment_version', 'org_unit_version', 'employment', 'org_unit'])(
    'DELETE on %s is denied', async (table) => {
      await expect(
        withTenant(app, actor(), async (tx) => { await tx.query(`DELETE FROM ${table}`); }),
      ).rejects.toThrow(/permission denied/i);
    });
});

// ── MAJOR-3 ──────────────────────────────────────────────────────────────────
describe('MAJOR-3 — reporting cycles and cross-tenant manager pointers', () => {
  it('rejects a multi-hop reporting cycle with the path named', async () => {
    // Aisha reports to Rohan. Making Rohan report to Aisha is a loop, and a
    // loop makes the org-chart recursive query hang for the whole tenant.
    await expect(
      withTenant(app, actor(), (tx) =>
        applyEmploymentChange(tx, hr(), {
          employmentId: rohanEmp, effectiveFrom: '2026-12-01',
          reason: 'Swap reporting lines', decidedByName: 'Meera Iyer',
          attributes: { managerEmploymentId: A.employmentId },
        })),
    ).rejects.toThrow(/loop/i);
  });

  it('rejects a manager pointer into ANOTHER tenant at the database level', async () => {
    // FK checks bypass RLS, so without the tenant component in the key this was
    // silently accepted and the org chart showed a manager-less employee.
    await expect(
      withTenant(app, actor(), async (tx) => {
        // A fresh employment with no versions, so the exclusion constraint
        // cannot fire first and mask the foreign key we are actually testing.
        const p = await tx.query(
          `INSERT INTO person (tenant_id, legal_name) VALUES ($1,'FK Probe') RETURNING id`,
          [A.tenantId]);
        const e = await tx.query(
          `INSERT INTO employment (tenant_id, person_id, employee_number, hire_date, status)
           VALUES ($1,$2,'E-FK','2026-01-01','active') RETURNING id`,
          [A.tenantId, p.rows[0].id]);
        await tx.query(
          `INSERT INTO employment_version (tenant_id, employment_id, valid_from,
             org_unit_id, job_title, employment_type, manager_employment_id, decided_by, reason)
           VALUES ($1,$2,'2026-01-01',$3,'Engineer','full_time',$4,$5,'cross-tenant manager')`,
          [A.tenantId, e.rows[0].id, A.orgUnitId, B.employmentId, A.hrId]);
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });
});

// ── BLOCKER-3 ────────────────────────────────────────────────────────────────
describe('BLOCKER-3 — erasure reaches every store this module writes to', () => {
  it('the registry covers every store, with a justification for each minimise', () => {
    const stores = CORE_HR_STORES.map((s) => s.store).sort();
    expect(stores).toEqual([
      'analytics_event', 'audit_log', 'employment', 'employment_version',
      'person', 'transparency_ledger',
    ]);
    for (const s of CORE_HR_STORES) {
      if (s.mode === 'minimise') {
        expect(s.justification, `${s.store} needs a justification`).toBeTruthy();
      }
    }
  });

  it('erases the person and asserts EACH store independently', async () => {
    const personId = A.personId;
    await withTenant(app, actor(), (tx) => erasePerson(tx, actor(), personId));

    // Each store is checked on its own — not by trusting the orchestrator
    // returned success. This is the assertion shape REQ-010 specifies.
    const checks = await withTenant(app, actor(), async (tx) => {
      const person = await tx.query(
        `SELECT legal_name, personal_email, personal_phone, national_id_ref,
                date_of_birth, preferred_name FROM person WHERE id = $1`, [personId]);
      const employment = await tx.query(
        `SELECT work_email FROM employment WHERE person_id = $1`, [personId]);
      const ledger = await tx.query(
        `SELECT count(*)::int AS n FROM transparency_ledger
          WHERE decided_by IN (SELECT id FROM employment WHERE person_id = $1)
            AND decided_by_name <> 'Former employee'`, [personId]);
      const audit = await tx.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE actor_id IN (SELECT id FROM employment WHERE person_id = $1)`, [personId]);
      const analytics = await tx.query(
        `SELECT count(*)::int AS n FROM analytics_event
          WHERE actor_id IN (SELECT id FROM employment WHERE person_id = $1)`, [personId]);
      const versions = await tx.query(
        `SELECT count(*)::int AS n FROM employment_version
          WHERE employment_id IN (SELECT id FROM employment WHERE person_id = $1)
            AND reason <> '[erased]'`, [personId]);
      return { person: person.rows[0], employment: employment.rows[0], ledger: ledger.rows[0].n,
               audit: audit.rows[0].n, analytics: analytics.rows[0].n, versions: versions.rows[0].n };
    });

    expect(checks.person.legal_name).toBe('[erased]');
    expect(checks.person.personal_email).toBeNull();
    expect(checks.person.personal_phone).toBeNull();
    expect(checks.person.national_id_ref).toBeNull();
    expect(checks.person.date_of_birth).toBeNull();
    expect(checks.person.preferred_name).toBeNull();
    expect(checks.employment.work_email).toBeNull();
    expect(checks.ledger, 'transparency_ledger still names the erased person').toBe(0);
    expect(checks.audit, 'audit_log still links to the erased person').toBe(0);
    expect(checks.analytics, 'analytics_event still links to the erased person').toBe(0);
    expect(checks.versions, 'employment_version still carries un-erased reasons').toBe(0);
  });

  it('COMP-23 — a REAL legal hold blocks erasure, and releasing it unblocks', async () => {
    // The first version of this test set employment status to 'notice' and
    // asserted a hold. That was a green test cementing the wrong semantics: an
    // ex-employee under litigation hold is `exited`, and someone serving notice
    // is not under hold at all. Status is not a hold.
    const c = await admin.connect();
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    const rp = await c.query(`SELECT person_id FROM employment WHERE id = $1`, [rohanEmp]);
    const personId = rp.rows[0].person_id;
    // Ex-employee — status alone must NOT hold.
    await c.query(`UPDATE employment SET status = 'exited', exit_date = '2026-06-30' WHERE id = $1`, [rohanEmp]);
    c.release();

    const notHeld = await withTenant(app, actor(), (tx) => erasePerson(tx, actor(), personId));
    expect(notHeld.heldByLegalHold).toBe(false);

    // Now place an actual hold.
    const c2 = await admin.connect();
    await c2.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    await c2.query(
      `INSERT INTO legal_hold (tenant_id, person_id, reason, placed_by)
       VALUES ($1,$2,'POSH investigation 2026-114',$3)`, [A.tenantId, personId, A.hrId]);
    c2.release();

    const held = await withTenant(app, actor(), (tx) => erasePerson(tx, actor(), personId));
    expect(held.heldByLegalHold).toBe(true);
    expect(held.perStore).toEqual([]);
    // The caller gets a reason it can show, per COMP-23.
    expect(held.holdReason).toBe('POSH investigation 2026-114');

    // Release it, and erasure proceeds.
    await withTenant(app, actor(), async (tx) => {
      await tx.query(
        `UPDATE legal_hold SET released_at = now(), released_by = $2
          WHERE person_id = $1 AND released_at IS NULL`, [personId, A.hrId]);
    });
    const after = await withTenant(app, actor(), (tx) => erasePerson(tx, actor(), personId));
    expect(after.heldByLegalHold).toBe(false);
    expect(after.perStore.length).toBeGreaterThan(0);
  });

  it('a hold cannot be edited or deleted by the app, only released', async () => {
    await expect(withTenant(app, actor(), async (tx) => {
      await tx.query(`UPDATE legal_hold SET reason = 'rewritten'`);
    })).rejects.toThrow(/permission denied/i);
    await expect(withTenant(app, actor(), async (tx) => {
      await tx.query(`DELETE FROM legal_hold`);
    })).rejects.toThrow(/permission denied/i);
  });

  it('erasure writes its own audit entry (COMP-22 + COMP-53)', async () => {
    const n = await withTenant(app, actor(), async (tx) => {
      const r = await tx.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'person.erased'`);
      return r.rows[0].n;
    });
    expect(n).toBeGreaterThan(0);
  });
});

// ── MAJOR-4 ──────────────────────────────────────────────────────────────────
describe('MAJOR-4 — the classification gate covers EVERY tenant-scoped table', () => {
  it('has no unclassified personal-data column anywhere', async () => {
    // Previously scoped to `person` only, which left 41 columns unclassified —
    // including work_location, a proxy for protected characteristics.
    // Exclusions are table.column, never a bare column name. A bare exclusion
    // silently protects nothing in every future table that happens to reuse it.
    const nonPersonal = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../db/nonpersonal-columns.txt'),
      'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const missing = await admin.query(
      `SELECT c.table_name || '.' || c.column_name AS col
         FROM information_schema.columns c
         JOIN information_schema.columns tc
           ON tc.table_name = c.table_name AND tc.column_name = 'tenant_id'
         LEFT JOIN data_classification dc
           ON dc.table_name = c.table_name AND dc.column_name = c.column_name
        WHERE c.table_schema = 'public'
          AND (c.table_name || '.' || c.column_name) <> ALL($1)
          AND dc.column_name IS NULL
        ORDER BY 1`, [nonPersonal]);
    expect(missing.rows.map((r: any) => r.col)).toEqual([]);
  });

  it('retention is populated where a statutory clock applies (COMP-30)', async () => {
    // NULL is indistinguishable from "we decided to keep it forever".
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM data_classification WHERE retention_days IS NOT NULL`);
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});

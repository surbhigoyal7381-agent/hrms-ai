import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant } from './setup.js';
import { withTenant, asEmploymentId, type EmploymentId } from '../src/db.js';
import { applyEmploymentChange } from '../src/employment.js';
import type { Principal } from '../src/policy.js';
import { erasePerson } from '../src/erasure.js';

/**
 * Regression — "who is `actor_id`?" (COMP-22, PRIV-10, and the accountability
 * property in docs/07-fairness-and-transparency.md Part 2).
 *
 * The shipped code let the CALLER decide what went into `audit_log.actor_id`,
 * `analytics_event.actor_id` and `transparency_ledger.decided_by`, and nothing
 * — no foreign key, no check, no type — constrained it to be an `employment.id`.
 * Erasure then looked for those rows with
 *   `WHERE actor_id IN (SELECT id FROM employment WHERE person_id = $1)`
 * and found none, so a person who had acted stayed named in three stores after
 * their data was erased.
 *
 * Every assertion below is grounded in an identifier this file captured from an
 * `INSERT ... RETURNING id`, or in a count taken BEFORE erasure. None of them
 * re-uses the production code's own predicate — that is what let the original
 * test pass while comparing zero to zero.
 */
const DB = 'hrms_actor_referent_test';
let app: pg.Pool;
let admin: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
let B: Awaited<ReturnType<typeof seedTenant>>;
let payments: string;

/** Real employment rows, captured from RETURNING id. Nothing is hardcoded. */
let rohanEmploymentId: EmploymentId;
let rohanPersonId: string;
let hrEmploymentId: EmploymentId;

/**
 * A login account id — what an identity provider hands the transport layer.
 * It is deliberately NOT any employment id, because in the real system it never
 * is. Every fixture in the shipped suite quietly used one of these as `actorId`.
 */
const ROHAN_LOGIN_ACCOUNT = '11111111-1111-1111-1111-111111111111';
const HR_LOGIN_ACCOUNT = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Acme', region: 'eu' });
  B = await seedTenant(admin, { name: 'Borealis', region: 'in' });

  const c = await admin.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);

  const ou = await c.query(
    `INSERT INTO org_unit (tenant_id, code) VALUES ($1,'PAY') RETURNING id`, [A.tenantId]);
  payments = ou.rows[0].id;
  await c.query(
    `INSERT INTO org_unit_version (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
     VALUES ($1,$2,'Payments','2020-01-01',$3,'setup')`,
    [A.tenantId, payments, A.hrEmploymentId]);

  // Rohan — a real human with a real employment, who will act and then be erased.
  const rp = await c.query(
    `INSERT INTO person (tenant_id, legal_name) VALUES ($1,'Rohan Mehta') RETURNING id`,
    [A.tenantId]);
  rohanPersonId = rp.rows[0].id;
  const re = await c.query(
    `INSERT INTO employment (tenant_id, person_id, employee_number, hire_date, status)
     VALUES ($1,$2,'E-2002','2021-01-04','active') RETURNING id`,
    [A.tenantId, rohanPersonId]);
  rohanEmploymentId = asEmploymentId(re.rows[0].id);
  await c.query(
    `INSERT INTO employment_version (tenant_id, employment_id, valid_from, org_unit_id,
       job_title, employment_type, decided_by, reason)
     VALUES ($1,$2,'2021-01-04',$3,'Engineering Manager','full_time',$4,'Initial hire')`,
    [A.tenantId, rohanEmploymentId, A.orgUnitId, A.hrEmploymentId]);

  // Rohan manages Aisha, so he is authorised to change her record.
  await c.query(
    `UPDATE employment_version SET manager_employment_id = $2 WHERE employment_id = $1`,
    [A.employmentId, rohanEmploymentId]);

  hrEmploymentId = A.hrEmploymentId;
  c.release();
}, 60_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

const hrActor = () => ({ tenantId: A.tenantId, actorEmploymentId: hrEmploymentId });
const rohanActor = () => ({ tenantId: A.tenantId, actorEmploymentId: rohanEmploymentId });
const rohan = (): Principal => ({
  tenantId: A.tenantId,
  actorEmploymentId: rohanEmploymentId,
  roles: new Set(['manager']),
});

async function rohanChangesAishasTeam(effectiveFrom: string) {
  return withTenant(app, rohanActor(), (tx) =>
    applyEmploymentChange(tx, rohan(), {
      employmentId: A.employmentId,
      effectiveFrom,
      reason: 'Moving to Payments',
      decidedByName: 'Rohan Mehta',
      attributes: { orgUnitId: payments },
    }));
}

describe('actor_id refers to an employment, and to the employment that acted', () => {
  it('records the ACTING employment in all four accountability columns', async () => {
    const res = await rohanChangesAishasTeam('2026-09-01');

    const rows = await withTenant(app, hrActor(), async (tx) => {
      const version = await tx.query(
        `SELECT decided_by FROM employment_version WHERE id = $1`, [res.versionId]);
      const ledger = await tx.query(
        `SELECT decided_by FROM transparency_ledger
          WHERE subject_employment_id = $1 ORDER BY decided_at DESC LIMIT 1`,
        [A.employmentId]);
      const audit = await tx.query(
        `SELECT actor_id FROM audit_log
          WHERE action = 'employment.attribute_changed' AND resource_id = $1
          ORDER BY at DESC LIMIT 1`, [A.employmentId]);
      const analytics = await tx.query(
        `SELECT actor_id FROM analytics_event
          WHERE name = 'employee.attribute_changed' ORDER BY at DESC LIMIT 1`);
      return {
        version: version.rows[0].decided_by,
        ledger: ledger.rows[0].decided_by,
        audit: audit.rows[0].actor_id,
        analytics: analytics.rows[0].actor_id,
      };
    });

    // Grounded in the id captured from INSERT ... RETURNING, NOT re-derived from
    // the Principal the code was handed. Asserting `=== principal.actorId` is a
    // tautology that passes for any value, including a login account id.
    expect(rows.version, 'employment_version.decided_by').toBe(rohanEmploymentId);
    expect(rows.ledger, 'transparency_ledger.decided_by').toBe(rohanEmploymentId);
    expect(rows.audit, 'audit_log.actor_id').toBe(rohanEmploymentId);
    expect(rows.analytics, 'analytics_event.actor_id').toBe(rohanEmploymentId);

    // And the login account id must appear NOWHERE — it is not an employment.
    expect(rows.version).not.toBe(ROHAN_LOGIN_ACCOUNT);
    expect(rows.audit).not.toBe(ROHAN_LOGIN_ACCOUNT);
  });

  it('every actor reference in every store resolves to a real employment row', async () => {
    // The structural claim, asked without using the erasure predicate: is there
    // any actor value anywhere that is not an employment id? This is what a
    // foreign key guarantees and what its absence allowed.
    const orphans = await withTenant(app, hrActor(), async (tx) => {
      const q = async (table: string, column: string): Promise<number> => {
        const r = await tx.query(
          `SELECT count(*)::int AS n FROM ${table} t
            WHERE t.${column} IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM employment e WHERE e.id = t.${column})`);
        return r.rows[0].n as number;
      };
      return {
        audit: await q('audit_log', 'actor_id'),
        analytics: await q('analytics_event', 'actor_id'),
        ledger: await q('transparency_ledger', 'decided_by'),
        version: await q('employment_version', 'decided_by'),
        orgVersion: await q('org_unit_version', 'decided_by'),
      };
    });
    expect(orphans.audit, 'audit_log.actor_id values with no employment').toBe(0);
    expect(orphans.analytics, 'analytics_event.actor_id values with no employment').toBe(0);
    expect(orphans.ledger, 'transparency_ledger.decided_by values with no employment').toBe(0);
    expect(orphans.version, 'employment_version.decided_by values with no employment').toBe(0);
    expect(orphans.orgVersion, 'org_unit_version.decided_by values with no employment').toBe(0);
  });

  it('the database REFUSES an actor id that is not an employment', async () => {
    // Discouraged is not prevented. If this insert succeeds, every guarantee
    // above is a convention that one bad code path walks around.
    await expect(
      withTenant(app, hrActor(), async (tx) => {
        await tx.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, resource_type, resource_id)
           VALUES ($1,$2,'probe','employment',$3)`,
          [A.tenantId, ROHAN_LOGIN_ACCOUNT, A.employmentId]);
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);

    await expect(
      withTenant(app, hrActor(), async (tx) => {
        await tx.query(
          `INSERT INTO analytics_event (tenant_id, name, actor_id)
           VALUES ($1,'probe',$2)`,
          [A.tenantId, HR_LOGIN_ACCOUNT]);
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it('the database REFUSES an actor id belonging to another tenant', async () => {
    // Foreign-key checks bypass RLS. Without the tenant component in the key,
    // tenant A can name a tenant-B employment as the accountable human, and the
    // ledger entry Aisha reads would point at a stranger in another company.
    await expect(
      withTenant(app, hrActor(), async (tx) => {
        await tx.query(
          `INSERT INTO audit_log (tenant_id, actor_id, action, resource_type, resource_id)
           VALUES ($1,$2,'probe','employment',$3)`,
          [A.tenantId, B.employmentId, A.employmentId]);
      }),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });
});

describe('COMP-22 — erasing a person who ACTED reaches every store', () => {
  it('erases Rohan from every store that names him, counted before and after', async () => {
    await rohanChangesAishasTeam('2027-02-01');

    // The guard that the shipped test lacked: prove there is something to erase.
    // Without this, every assertion after the erasure compares zero to zero and
    // would pass with the erasure step deleted.
    const before = await withTenant(app, hrActor(), async (tx) => {
      const q = async (sql: string, p: unknown[]): Promise<number> =>
        (await tx.query(sql, p)).rows[0].n as number;
      return {
        audit: await q(`SELECT count(*)::int n FROM audit_log WHERE actor_id = $1`,
          [rohanEmploymentId]),
        analytics: await q(`SELECT count(*)::int n FROM analytics_event WHERE actor_id = $1`,
          [rohanEmploymentId]),
        ledger: await q(`SELECT count(*)::int n FROM transparency_ledger WHERE decided_by = $1`,
          [rohanEmploymentId]),
        versions: await q(
          `SELECT count(*)::int n FROM employment_version WHERE employment_id = $1`,
          [rohanEmploymentId]),
      };
    });
    expect(before.audit, 'nothing in audit_log names Rohan — the test would be vacuous')
      .toBeGreaterThan(0);
    expect(before.analytics, 'nothing in analytics_event names Rohan — the test would be vacuous')
      .toBeGreaterThan(0);
    expect(before.ledger, 'nothing in transparency_ledger names Rohan — the test would be vacuous')
      .toBeGreaterThan(0);
    expect(before.versions, 'Rohan has no employment_version rows — the test would be vacuous')
      .toBeGreaterThan(0);

    const result = await withTenant(app, hrActor(), (tx) =>
      erasePerson(tx, hrActor(), rohanPersonId));
    expect(result.heldByLegalHold).toBe(false);

    const after = await withTenant(app, hrActor(), async (tx) => {
      const q = async (sql: string, p: unknown[]): Promise<number> =>
        (await tx.query(sql, p)).rows[0].n as number;
      return {
        // audit_log and analytics_event: the actor link is removed outright.
        auditStillNamingRohan: await q(
          `SELECT count(*)::int n FROM audit_log WHERE actor_id = $1`, [rohanEmploymentId]),
        analyticsStillNamingRohan: await q(
          `SELECT count(*)::int n FROM analytics_event WHERE actor_id = $1`, [rohanEmploymentId]),
        // The ledger keeps decided_by (it is append-only and other people's
        // entries must survive as their evidence); the NAME is pseudonymised.
        ledgerRowsStillNamingHim: await q(
          `SELECT count(*)::int n FROM transparency_ledger
            WHERE decided_by = $1 AND decided_by_name <> 'Former employee'`,
          [rohanEmploymentId]),
        versionsNotErased: await q(
          `SELECT count(*)::int n FROM employment_version
            WHERE employment_id = $1 AND reason <> '[erased]'`, [rohanEmploymentId]),
      };
    });

    expect(after.auditStillNamingRohan, 'audit_log still links to the erased person').toBe(0);
    expect(after.analyticsStillNamingRohan, 'analytics_event still links to the erased person')
      .toBe(0);
    expect(after.ledgerRowsStillNamingHim, 'transparency_ledger still names the erased person')
      .toBe(0);
    expect(after.versionsNotErased, 'employment_version still carries un-erased reasons').toBe(0);

    // The orchestrator must also REPORT what it did, per store, with non-zero
    // counts for the stores that actually held rows. A store silently reporting
    // 0 while rows remain is the failure REQ-010 exists to catch.
    const byStore = Object.fromEntries(result.perStore.map((s): [string, number] => [s.store, s.rowsAffected]));
    expect(byStore.audit_log, 'erasure reported touching no audit_log rows')
      .toBeGreaterThanOrEqual(before.audit);
    expect(byStore.analytics_event, 'erasure reported touching no analytics_event rows')
      .toBeGreaterThanOrEqual(before.analytics);
    expect(byStore.transparency_ledger, 'erasure reported touching no ledger rows')
      .toBeGreaterThanOrEqual(before.ledger);
  });
});

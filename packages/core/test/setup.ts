import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { asEmploymentId, type EmploymentId } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../db/migrations');

export const HOST = process.env.PGHOST ?? '/tmp/pgsock';
export const PORT = Number(process.env.PGPORT ?? 5433);
const ADMIN_DB = 'postgres';

export async function freshDatabase(name: string): Promise<pg.Pool> {
  const admin = new pg.Client({ host: HOST, port: PORT, user: 'postgres', database: ADMIN_DB });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  // hrms_app is NOLOGIN in the migration (production grants it to a login role).
  // Tests need to connect as it directly to prove RLS applies to a non-owner.
  await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrms_app') THEN
        CREATE ROLE hrms_app NOLOGIN NOBYPASSRLS;
      END IF;
      ALTER ROLE hrms_app LOGIN;
    END $$;`);
  await admin.end();

  // EVERY migration, in order — not just 0001. Pinning the test harness to one
  // named file means the suite silently keeps testing an older schema than the
  // one that ships, and the next migration's constraints are never exercised.
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  for (const file of files) {
    execFileSync('psql', [
      '-h', HOST, '-p', String(PORT), '-U', 'postgres', '-d', name,
      '-v', 'ON_ERROR_STOP=1', '-q', '-f', join(MIGRATIONS_DIR, file),
    ], { stdio: 'pipe' });
  }

  // Connect as hrms_app — the non-owner application role — NOT as postgres.
  // Testing RLS as the superuser would prove nothing.
  return new pg.Pool({ host: HOST, port: PORT, user: 'hrms_app', database: name, max: 4 });
}

export async function adminPool(name: string): Promise<pg.Pool> {
  return new pg.Pool({ host: HOST, port: PORT, user: 'postgres', database: name, max: 2 });
}

export interface SeededTenant {
  tenantId: string;
  /** Engineering. Aisha is in it; Meera deliberately is not. */
  orgUnitId: string;
  /** Aisha. */
  employmentId: string;
  personId: string;
  /** Meera, the HR admin who decides things. A REAL employment row. */
  hrEmploymentId: EmploymentId;
  hrPersonId: string;
}

/**
 * Seeds one tenant with an HR admin, an org unit and one employee.
 * Runs as owner (setup, not app path).
 *
 * The HR admin used to be a hardcoded constant,
 * `'00000000-0000-0000-0000-0000000000aa'`, that was never inserted into
 * `employment`. It was passed as the actor everywhere, so `audit_log.actor_id`,
 * `analytics_event.actor_id` and `transparency_ledger.decided_by` all held a
 * uuid that matched no employment — and the erasure test, which looked for rows
 * by joining those columns to `employment`, found nothing to check and passed.
 * The fixture and the production code were wrong in the same direction, so
 * neither could reveal the other.
 *
 * The id is now generated per tenant, so two tenants never share an actor id
 * either — which the old constant also quietly did.
 */
export async function seedTenant(
  admin: pg.Pool,
  opts: { name: string; region: 'eu' | 'in' },
): Promise<SeededTenant> {
  const c = await admin.connect();
  try {
    const t = await c.query(
      `INSERT INTO tenant (name, region) VALUES ($1,$2) RETURNING id`, [opts.name, opts.region]);
    const tenantId = t.rows[0].id;

    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

    // Bootstrap order matters, and it is the identity/version split that makes
    // it possible: `employment` (identity) does not reference an org unit, so
    // the first HR admin can exist before any org unit does, and then be the
    // recorded decider for the org unit's first version.
    const hrp = await c.query(
      `INSERT INTO person (tenant_id, legal_name, preferred_name)
       VALUES ($1,'Meera Iyer','Meera') RETURNING id`, [tenantId]);
    const hrPersonId = hrp.rows[0].id;
    const hre = await c.query(
      `INSERT INTO employment (tenant_id, person_id, employee_number, hire_date, status)
       VALUES ($1,$2,'E-0001','2019-06-03','active') RETURNING id`, [tenantId, hrPersonId]);
    const hrEmploymentId = asEmploymentId(hre.rows[0].id);

    // Meera sits in People Ops, NOT in Engineering. Making the HR admin a real
    // employee adds a body to the headcount, and putting her in Engineering
    // would have quietly changed the answer to "how many people are in
    // Engineering on 31 August" — the exact number REQ-004's tests pin down.
    // A fixture that moves a headcount is a fixture that hides a regression.
    const hrOu = await c.query(
      `INSERT INTO org_unit (tenant_id, code) VALUES ($1,'PPL') RETURNING id`, [tenantId]);
    await c.query(
      `INSERT INTO org_unit_version
         (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
       VALUES ($1,$2,'People Ops','2019-01-01',$3,'Initial org setup')`,
      [tenantId, hrOu.rows[0].id, hrEmploymentId]);
    await c.query(
      `INSERT INTO employment_version
         (tenant_id, employment_id, valid_from, org_unit_id, job_title,
          employment_type, decided_by, reason)
       VALUES ($1,$2,'2019-06-03',$3,'HR Business Partner','full_time',$4,'Initial hire')`,
      [tenantId, hrEmploymentId, hrOu.rows[0].id, hrEmploymentId]);

    const ou = await c.query(
      `INSERT INTO org_unit (tenant_id, code) VALUES ($1,'ENG') RETURNING id`, [tenantId]);
    const orgUnitId = ou.rows[0].id;
    await c.query(
      `INSERT INTO org_unit_version
         (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
       VALUES ($1,$2,'Engineering','2020-01-01',$3,'Initial org setup')`,
      [tenantId, orgUnitId, hrEmploymentId]);

    const p = await c.query(
      `INSERT INTO person (tenant_id, legal_name, preferred_name, personal_email)
       VALUES ($1,'Aisha Kumar','Aisha','aisha@example.com') RETURNING id`, [tenantId]);

    const e = await c.query(
      `INSERT INTO employment (tenant_id, person_id, employee_number, work_email, hire_date, status)
       VALUES ($1,$2,'E-1001','aisha@' || $3 || '.example','2023-04-12','active') RETURNING id`,
      [tenantId, p.rows[0].id, opts.name.toLowerCase()]);
    const employmentId = e.rows[0].id;

    await c.query(
      `INSERT INTO employment_version
         (tenant_id, employment_id, valid_from, org_unit_id, job_title, employment_type, decided_by, reason)
       VALUES ($1,$2,'2023-04-12',$3,'Engineer','full_time',$4,'Initial hire')`,
      [tenantId, employmentId, orgUnitId, hrEmploymentId]);

    return {
      tenantId, orgUnitId, employmentId, hrEmploymentId, hrPersonId,
      personId: p.rows[0].id,
    };
  } finally {
    c.release();
  }
}

/**
 * Runs WITHOUT a tenant context, to prove the fail-closed property: an unset
 * `app.tenant_id` must yield ZERO rows, never all rows.
 * Test-only — deliberately not exported from the shipped package.
 */
export async function withoutTenant<T>(
  pool: import('pg').Pool,
  fn: (tx: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

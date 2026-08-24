import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(here, '../../db/migrations/0001_core_hr_foundation.sql');

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

  execFileSync('psql', [
    '-h', HOST, '-p', String(PORT), '-U', 'postgres', '-d', name,
    '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION,
  ], { stdio: 'pipe' });

  // Connect as hrms_app — the non-owner application role — NOT as postgres.
  // Testing RLS as the superuser would prove nothing.
  return new pg.Pool({ host: HOST, port: PORT, user: 'hrms_app', database: name, max: 4 });
}

export async function adminPool(name: string): Promise<pg.Pool> {
  return new pg.Pool({ host: HOST, port: PORT, user: 'postgres', database: name, max: 2 });
}

/** Seeds one tenant with an org unit and one employee. Runs as owner (setup, not app path). */
export async function seedTenant(admin: pg.Pool, opts: { name: string; region: 'eu' | 'in' }) {
  const c = await admin.connect();
  try {
    const t = await c.query(`INSERT INTO tenant (name, region) VALUES ($1,$2) RETURNING id`, [opts.name, opts.region]);
    const tenantId = t.rows[0].id;
    const hrId = '00000000-0000-0000-0000-0000000000aa';

    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);

    // Identity and version are now separate: a reorganisation appends a version
    // and the identity survives, so employment_version keeps pointing at a live
    // org unit and headcount survives the reorg.
    const ou = await c.query(
      `INSERT INTO org_unit (tenant_id, code) VALUES ($1,'ENG') RETURNING id`, [tenantId]);
    const orgUnitId = ou.rows[0].id;
    await c.query(
      `INSERT INTO org_unit_version
         (tenant_id, org_unit_id, name, valid_from, decided_by, reason)
       VALUES ($1,$2,'Engineering','2020-01-01',$3,'Initial org setup')`,
      [tenantId, orgUnitId, hrId]);

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
      [tenantId, employmentId, orgUnitId, hrId]);

    return { tenantId, orgUnitId, employmentId, hrId, personId: p.rows[0].id };
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant, withoutTenant } from './setup.js';
import { withTenant } from '../src/db.js';

/**
 * REQ-001 — tenant isolation.
 *
 * The highest-consequence requirement in the module. These tests connect as
 * `hrms_app`, the NON-OWNER application role — testing RLS as the superuser
 * would prove nothing.
 *
 * This file must never be deleted or skipped.
 */
const DB = 'hrms_rls_test';

let app: pg.Pool;
let admin: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
let B: Awaited<ReturnType<typeof seedTenant>>;

/**
 * Derived from the catalogue, NOT hand-maintained. The previous hand-written
 * array omitted `tenant`, and the suite's own definition of "every tenant-scoped
 * table" inherited the omission — 28 tests passed while any tenant could read
 * the full customer list and rewrite another tenant's residency region.
 * A new table now cannot be forgotten the same way.
 */
let TENANT_SCOPED: string[] = [];

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Acme', region: 'eu' });
  B = await seedTenant(admin, { name: 'Borealis', region: 'in' });

  const cat = await admin.query(`
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (c.relname = 'tenant' OR EXISTS (
             SELECT 1 FROM information_schema.columns col
              WHERE col.table_name = c.relname AND col.column_name = 'tenant_id'))
     ORDER BY c.relname`);
  TENANT_SCOPED = cat.rows.map((r: any) => r.relname);
  if (TENANT_SCOPED.length < 9) throw new Error('catalogue sweep found too few tables');
}, 60_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe('RLS is configured correctly', () => {
  it('every tenant-scoped table has RLS ENABLED and FORCED', async () => {
    // FORCE matters: ENABLE alone does not apply to the table owner, and app
    // connections very often run as the owner. This is the most common
    // multi-tenant leak in exactly this architecture.
    const res = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
      [TENANT_SCOPED],
    );
    expect(res.rows).toHaveLength(TENANT_SCOPED.length);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS FORCED`).toBe(true);
    }
  });

  it('the application role cannot bypass RLS', async () => {
    const res = await admin.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'hrms_app'`);
    expect(res.rows[0].rolbypassrls).toBe(false);
  });
});

describe('cross-tenant reads', () => {
  it('tenant A sees none of tenant B rows, in EVERY tenant-scoped table', async () => {
    for (const table of TENANT_SCOPED) {
      const col = table === 'tenant' ? 'id' : 'tenant_id';
      const rows = await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        const r = await tx.query(`SELECT ${col} AS t FROM ${table}`);
        return r.rows;
      });
      for (const row of rows) {
        expect(row.t, `${table} leaked a row`).toBe(A.tenantId);
      }
    }
  });

  it('tenant A cannot see tenant B in the tenant registry itself', async () => {
    // The customer list is not public data, and `region` carries the COMP-40
    // residency decision.
    const rows = await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
      const r = await tx.query(`SELECT id, name FROM tenant`);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(A.tenantId);
  });

  it('the app role cannot rewrite another tenant residency region', async () => {
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(`UPDATE tenant SET region = 'eu' WHERE id = $1`, [B.tenantId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('fetching tenant B employment by its exact id from tenant A returns nothing', async () => {
    // Must be indistinguishable from "does not exist" — a 403 would confirm
    // the record exists, which is itself a leak.
    const rows = await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
      const r = await tx.query(`SELECT * FROM employment WHERE id = $1`, [B.employmentId]);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('the same query in tenant B does find it — proving the test is meaningful', async () => {
    const rows = await withTenant(app, { tenantId: B.tenantId, actorEmploymentId: B.hrEmploymentId }, async (tx) => {
      const r = await tx.query(`SELECT * FROM employment WHERE id = $1`, [B.employmentId]);
      return r.rows;
    });
    expect(rows).toHaveLength(1);
  });
});

describe('cross-tenant writes', () => {
  it('cannot insert a row carrying another tenant id', async () => {
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(
          `INSERT INTO person (tenant_id, legal_name) VALUES ($1, 'Injected')`,
          [B.tenantId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update another tenant row', async () => {
    const updated = await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
      const r = await tx.query(
        `UPDATE employment SET employee_number = 'HACKED' WHERE id = $1`,
        [B.employmentId],
      );
      return r.rowCount;
    });
    expect(updated).toBe(0);

    const still = await withTenant(app, { tenantId: B.tenantId, actorEmploymentId: B.hrEmploymentId }, async (tx) => {
      const r = await tx.query(`SELECT employee_number FROM employment WHERE id = $1`, [B.employmentId]);
      return r.rows[0].employee_number;
    });
    expect(still).toBe('E-1001');
  });

  it('cannot delete another tenant row', async () => {
    const deleted = await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
      const r = await tx.query(`DELETE FROM person WHERE tenant_id = $1`, [B.tenantId]);
      return r.rowCount;
    });
    expect(deleted).toBe(0);
  });
});

describe('fail-closed: an unset tenant context yields ZERO rows, never all rows', () => {
  it('every tenant-scoped table returns nothing with no app.tenant_id set', async () => {
    for (const table of TENANT_SCOPED) {
    // The whole safety argument rests on this. A bug that drops the session
    // variable must degrade to an empty screen, not a data breach.
      const rows = await withoutTenant(app, async (tx: any) => {
        const r = await tx.query(`SELECT 1 FROM ${table}`);
        return r.rows;
      });
      expect(rows, `${table} returned rows with no tenant set`).toHaveLength(0);
    }
  });

  it('an empty-string tenant setting also yields zero rows', async () => {
    // `current_tenant()` maps '' to NULL and every policy compares with `=`,
    // which is NULL-safe-false. Unset and empty must both mean ZERO rows.
    //
    // Set with `SET LOCAL`, not `set_config`: migration 0003 revokes
    // `set_config` from the app role (lock 1). Plain `SET` still works for this
    // role, which is exactly WHY lock 2 exists — see the test below.
    const rows = await withoutTenant(app, async (tx: any) => {
      await tx.query(`SET LOCAL app.tenant_id = ''`);
      const r = await tx.query(`SELECT 1 FROM person`);
      return r.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

// ── The four tenant-identity locks ───────────────────────────────────────────
// docs/99-decision-log.md, 2026-08-26, one-way door 1.
//
// RLS answers "which tenant's rows are these". It cannot answer "is the session
// telling the truth about which tenant it is". These four assertions are that
// second question. Deleting one re-opens a full cross-tenant breach path.
describe('tenant-identity locks (one-way door 1)', () => {
  it('LOCK 1 — the app role cannot call set_config', async () => {
    await expect(
      withoutTenant(app, async (tx: any) => {
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [B.tenantId]);
      }),
    ).rejects.toThrow(/permission denied for function set_config/i);
  });

  it('LOCK 4 — the app role cannot run a DO block', async () => {
    // A DO block is ONE statement, so lock 2 permits it, and `EXECUTE 'SET ...'`
    // inside PL/pgSQL is a utility statement, so lock 1 never sees it. This is
    // the bypass the first three locks did not close.
    await expect(
      withoutTenant(app, async (tx: any) => {
        await tx.query(`DO $$ BEGIN EXECUTE 'SET app.tenant_id = ''x'''; END $$;`);
      }),
    ).rejects.toThrow(/permission denied for language plpgsql/i);
  });

  it('LOCK 2 — a stacked second statement cannot reach the database', async () => {
    // The escalation path in one line: inject `; SET app.tenant_id = '<victim>'`
    // and read another customer's data. PostgreSQL refuses multiple commands in
    // a prepared statement, and `withTenant` hands out a Tx that can only issue
    // prepared statements.
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(`SELECT 1; SET app.tenant_id = '${B.tenantId}'`);
      }),
    ).rejects.toThrow(/cannot insert multiple commands into a prepared statement/i);
  });

  it('LOCK 3 — the tenant cannot be changed once the transaction has one', async () => {
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(`SELECT begin_tenant_session($1, $2)`, [B.tenantId, A.hrEmploymentId]);
      }),
    ).rejects.toThrow(/tenant already set for this transaction/i);
  });

  it('the locks do not break the legitimate path', async () => {
    // A lock that also breaks the product is not a lock, it is an outage. This
    // is the positive control for the four assertions above.
    const n = await withTenant(
      app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId },
      async (tx) => {
        const r = await tx.query(`SELECT count(*)::int AS n FROM person`);
        return r.rows[0].n as number;
      });
    expect(n, 'tenant A should see its own people').toBeGreaterThan(0);
  });
});

describe('audit log immutability (COMP-53)', () => {
  it('the app role can INSERT into audit_log', async () => {
    await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
      await tx.query(
        `INSERT INTO audit_log
           (tenant_id, actor_id, actor_kind, actor_display_name,
            action, resource_type, resource_id, subject_person_id)
         VALUES ($1,$2,'human','Meera Iyer','test.write','employment',$3,$4)`,
        [A.tenantId, A.hrEmploymentId, A.employmentId, A.personId],
      );
    });
    const n = await withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
      const r = await tx.query(`SELECT count(*)::int AS n FROM audit_log`);
      return r.rows[0].n;
    });
    expect(n).toBeGreaterThan(0);
  });

  it('the app role CANNOT update an audit entry', async () => {
    // Enforced by a database grant, not by a code-review convention.
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(`UPDATE audit_log SET action = 'tampered'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the app role CANNOT delete an audit entry', async () => {
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(`DELETE FROM audit_log`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the app role cannot rewrite a transparency ledger entry', async () => {
    // Corrections append. Rewriting a reason after the fact is exactly what a
    // ledger exists to prevent.
    await expect(
      withTenant(app, { tenantId: A.tenantId, actorEmploymentId: A.hrEmploymentId }, async (tx) => {
        await tx.query(`UPDATE transparency_ledger SET reason = 'rewritten'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

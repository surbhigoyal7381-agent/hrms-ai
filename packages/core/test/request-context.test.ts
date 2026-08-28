import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant } from './setup.js';
import { withTenantForResolution } from '../src/db.js';
import { resolveRequestContext } from '../src/request-context.js';

/**
 * SEC-01 / REQ-016 / REQ-022 — resolving who a request is from.
 *
 * Every fixture is written through the OWNER role and every assertion is
 * grounded in an id this file captured, never re-read through the resolver.
 */
const DB = 'hrms_request_context_test';
let app: pg.Pool;
let admin: pg.Pool;
let A: Awaited<ReturnType<typeof seedTenant>>;
let B: Awaited<ReturnType<typeof seedTenant>>;

const AISHA_SUBJECT = 'kc-11111111-1111-1111-1111-111111111111';
const BOREALIS_SUBJECT = 'kc-22222222-2222-2222-2222-222222222222';
const NOBODY_SUBJECT = 'kc-99999999-9999-9999-9999-999999999999';

async function asOwner<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    return await fn(c);
  } finally {
    c.release();
  }
}

async function linkSubject(tenantId: string, personId: string, subject: string) {
  await asOwner(tenantId, (c) => c.query(
    `INSERT INTO identity_link (tenant_id, person_id, subject) VALUES ($1,$2,$3)`,
    [tenantId, personId, subject]));
}

const resolve = (tenantId: string, subject: string) =>
  withTenantForResolution(app, tenantId, (tx) => resolveRequestContext(tx, subject));

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Northwind', region: 'eu' });
  B = await seedTenant(admin, { name: 'Borealis', region: 'in' });
  await linkSubject(A.tenantId, A.personId, AISHA_SUBJECT);
  await linkSubject(B.tenantId, B.personId, BOREALIS_SUBJECT);
}, 60_000);

afterAll(async () => { await app?.end(); await admin?.end(); });

describe('resolving a subject', () => {
  it('resolves to the person and employment this file seeded', async () => {
    const ctx = await resolve(A.tenantId, AISHA_SUBJECT);
    expect(ctx, 'a linked subject failed to resolve').not.toBeNull();
    // Grounded in the ids seedTenant returned, not in anything the resolver said.
    expect(ctx!.personId).toBe(A.personId);
    expect(ctx!.employmentId).toBe(A.employmentId);
    expect(ctx!.tenantId).toBe(A.tenantId);
    expect(ctx!.lifecycle).toBe('employed');
  });

  it('a subject with no identity_link resolves to NOTHING, and does not throw', async () => {
    // Fail closed, and fail closed as a VALUE. An exception invites a `catch`
    // that carries on; a null forces the caller to decide, and the compiler
    // will not let it be ignored.
    const ctx = await resolve(A.tenantId, NOBODY_SUBJECT);
    expect(ctx).toBeNull();
  });

  it('an empty subject resolves to nothing', async () => {
    expect(await resolve(A.tenantId, '')).toBeNull();
    expect(await resolve(A.tenantId, '   ')).toBeNull();
  });

  it("another tenant's subject resolves to nothing here", async () => {
    // The strongest property in this file. Borealis's subject is real, live and
    // resolvable — in Borealis. Presented at Northwind's address it must resolve
    // to nothing, not to a Borealis employee.
    const inOwnTenant = await resolve(B.tenantId, BOREALIS_SUBJECT);
    expect(inOwnTenant, 'fixture: the subject should resolve in its own tenant').not.toBeNull();
    expect(inOwnTenant!.personId).toBe(B.personId);

    const crossTenant = await resolve(A.tenantId, BOREALIS_SUBJECT);
    expect(crossTenant, 'a subject resolved across a tenant boundary').toBeNull();
  });

  it('a disabled link stops resolving', async () => {
    const subject = 'kc-disabled-0000-0000-0000-000000000001';
    await asOwner(A.tenantId, (c) => c.query(
      `INSERT INTO identity_link (tenant_id, person_id, subject, disabled_at)
       VALUES ($1,$2,$3, now())`, [A.tenantId, A.hrPersonId, subject]));

    // Independent oracle: the row exists, so "resolves to nothing" cannot mean
    // "was never inserted".
    const seeded = await asOwner(A.tenantId, (c) => c.query(
      `SELECT count(*)::int AS n FROM identity_link WHERE subject = $1`, [subject]));
    expect(seeded.rows[0].n, 'fixture: the disabled link should exist').toBe(1);

    expect(await resolve(A.tenantId, subject)).toBeNull();
  });
});

describe('RULE-001 through the resolver, not just through settings.ts', () => {
  it('an UNSET setting resolves to off', async () => {
    // Northwind has never had a setting row written. Verified independently.
    const rows = await asOwner(A.tenantId, (c) => c.query(
      `SELECT count(*)::int AS n FROM tenant_record_view_setting WHERE tenant_id = $1`,
      [A.tenantId]));
    expect(rows.rows[0].n, 'fixture: tenant A should have no setting row').toBe(0);

    const ctx = await resolve(A.tenantId, AISHA_SUBJECT);
    expect(ctx!.recordViewEnabled, 'unset must resolve to off').toBe(false);
    expect(ctx!.settingSource).toBe('unset');
  });

  it('an explicit ON resolves to on, and OFF back to off', async () => {
    // Positive control for the assertion above: if the resolver returned false
    // unconditionally, that test would pass and this one would not.
    await asOwner(B.tenantId, (c) => c.query(
      `INSERT INTO tenant_record_view_setting
         (tenant_id, record_view_enabled, changed_by, changed_by_name, reason, changed_at)
       VALUES ($1,true,$2,'Meera Iyer','pilot','2026-08-01T10:00:00Z')`,
      [B.tenantId, B.hrEmploymentId]));

    const on = await resolve(B.tenantId, BOREALIS_SUBJECT);
    expect(on!.recordViewEnabled).toBe(true);
    expect(on!.settingSource).toBe('stored');

    await asOwner(B.tenantId, (c) => c.query(
      `INSERT INTO tenant_record_view_setting
         (tenant_id, record_view_enabled, changed_by, changed_by_name, reason, changed_at)
       VALUES ($1,false,$2,'Meera Iyer','withdrawn','2026-08-02T10:00:00Z')`,
      [B.tenantId, B.hrEmploymentId]));

    const off = await resolve(B.tenantId, BOREALIS_SUBJECT);
    expect(off!.recordViewEnabled, 'a later OFF must beat an earlier ON').toBe(false);
  });
});

describe('REQ-022 — the exit lifecycle is computed per call, never cached', () => {
  it('changing the exit date changes the answer on the very next call', async () => {
    const before = await resolve(A.tenantId, AISHA_SUBJECT);
    expect(before!.lifecycle).toBe('employed');
    expect(before!.exitDate).toBeNull();

    // A date in the past: she has left, whatever any status job thinks.
    await asOwner(A.tenantId, (c) => c.query(
      `UPDATE employment SET exit_date = '2026-01-31' WHERE id = $1`, [A.employmentId]));

    const after = await resolve(A.tenantId, AISHA_SUBJECT);
    expect(after!.lifecycle, 'the lifecycle was cached across calls').toBe('exited');
    expect(after!.exitDate).toBe('2026-01-31');

    // RULE-013: counted from the DATE, not from the status transition — the
    // transition is a job that can run late, and the date is the business fact.
    const status = await asOwner(A.tenantId, (c) => c.query(
      `SELECT status::text AS s FROM employment WHERE id = $1`, [A.employmentId]));
    expect(status.rows[0].s, 'fixture: status deliberately NOT updated').toBe('active');

    // ...and it goes back when the date is corrected forward, in the same session.
    await asOwner(A.tenantId, (c) => c.query(
      `UPDATE employment SET exit_date = NULL WHERE id = $1`, [A.employmentId]));
    const restored = await resolve(A.tenantId, AISHA_SUBJECT);
    expect(restored!.lifecycle).toBe('employed');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { freshDatabase, adminPool, seedTenant } from './setup.js';
import { withTenant } from '../src/db.js';
import {
  postgresRecordViewGate,
  requireRecordView,
  RecordViewDisabledError,
} from '../src/settings.js';

/**
 * RULE-001 — resolving the organisation switch.
 *
 * The requirement that actually matters is not "off works". It is that
 * **UNSET behaves identically to OFF**. A brand-new tenant has no row, and the
 * feature must be closed for it. Every state below is therefore seeded
 * explicitly and asserted against what this file inserted — never re-read
 * through the function under test.
 */
const DB = 'hrms_setting_test';
let app: pg.Pool;
let admin: pg.Pool;
/** Tenant A is left UNSET for the whole file. Nothing here ever writes its row. */
let A: Awaited<ReturnType<typeof seedTenant>>;
/** Tenant B is the one we flip. */
let B: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  A = await seedTenant(admin, { name: 'Northwind', region: 'eu' });
  B = await seedTenant(admin, { name: 'Borealis', region: 'in' });
}, 60_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

/** Writes a flip as the owner, so the test's oracle never goes through app code. */
async function seedFlip(
  tenant: Awaited<ReturnType<typeof seedTenant>>,
  enabled: boolean,
  changedAt?: string,
) {
  const c = await admin.connect();
  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant.tenantId]);
    await c.query(
      `INSERT INTO tenant_record_view_setting
         (tenant_id, record_view_enabled, changed_by, changed_by_name, reason, changed_at)
       VALUES ($1,$2,$3,'Meera Iyer','test fixture', coalesce($4::timestamptz, now()))`,
      [tenant.tenantId, enabled, tenant.hrEmploymentId, changedAt ?? null],
    );
  } finally {
    c.release();
  }
}

const actorFor = (t: Awaited<ReturnType<typeof seedTenant>>) => ({
  tenantId: t.tenantId,
  actorEmploymentId: t.hrEmploymentId,
});

describe('RULE-001 — the three states', () => {
  it('UNSET resolves to off, and says so', async () => {
    // Nothing has ever written a row for tenant A. Verified independently,
    // through the owner role, so the claim does not rest on the code under test.
    const c = await admin.connect();
    await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [A.tenantId]);
    const seeded = await c.query(
      `SELECT count(*)::int AS n FROM tenant_record_view_setting WHERE tenant_id = $1`,
      [A.tenantId]);
    c.release();
    expect(seeded.rows[0].n, 'fixture is wrong: tenant A should have no setting row').toBe(0);

    const res = await withTenant(app, actorFor(A), (tx) => postgresRecordViewGate.resolve(tx));
    expect(res.enabled).toBe(false);
    expect(res.source).toBe('unset');
    expect(res.changedAt).toBeNull();
  });

  it('an explicit OFF resolves to off', async () => {
    await seedFlip(B, false, '2026-08-01T10:00:00Z');
    const res = await withTenant(app, actorFor(B), (tx) => postgresRecordViewGate.resolve(tx));
    expect(res.enabled).toBe(false);
    expect(res.source).toBe('stored');
    expect(res.changedByName).toBe('Meera Iyer');
  });

  it('an explicit ON resolves to on', async () => {
    await seedFlip(B, true, '2026-08-02T10:00:00Z');
    const res = await withTenant(app, actorFor(B), (tx) => postgresRecordViewGate.resolve(tx));
    expect(res.enabled).toBe(true);
    expect(res.source).toBe('stored');
  });

  it('UNSET and OFF are indistinguishable to an authorisation decision', async () => {
    // The requirement in one assertion. A future refactor that makes "unset"
    // fall through to enabled passes every other test in this file except the
    // first one and this one.
    await seedFlip(B, false, '2026-08-03T10:00:00Z');

    const unset = await withTenant(app, actorFor(A), (tx) => postgresRecordViewGate.resolve(tx));
    const off = await withTenant(app, actorFor(B), (tx) => postgresRecordViewGate.resolve(tx));

    expect(unset.enabled, 'unset must be closed').toBe(false);
    expect(off.enabled, 'off must be closed').toBe(false);
    expect(unset.enabled).toBe(off.enabled);

    // ...and the gate must refuse both the same way, with the same code, so the
    // employee cannot tell "never configured" from "deliberately off" either.
    const unsetErr = await withTenant(app, actorFor(A), (tx) =>
      requireRecordView(tx).then(() => null, (e) => e));
    const offErr = await withTenant(app, actorFor(B), (tx) =>
      requireRecordView(tx).then(() => null, (e) => e));

    expect(unsetErr).toBeInstanceOf(RecordViewDisabledError);
    expect(offErr).toBeInstanceOf(RecordViewDisabledError);
    expect(unsetErr.code).toBe('RECORD_VIEW_DISABLED');
    expect(offErr.code).toBe(unsetErr.code);
    expect(offErr.status).toBe(403);
  });

  it('the newest flip wins, not the first', async () => {
    await seedFlip(B, true, '2026-09-01T09:00:00Z');
    await seedFlip(B, false, '2026-09-02T09:00:00Z');
    const res = await withTenant(app, actorFor(B), (tx) => postgresRecordViewGate.resolve(tx));
    expect(res.enabled, 'a later OFF must beat an earlier ON').toBe(false);

    await seedFlip(B, true, '2026-09-03T09:00:00Z');
    const back = await withTenant(app, actorFor(B), (tx) => postgresRecordViewGate.resolve(tx));
    expect(back.enabled).toBe(true);
  });

  it('requireRecordView returns the resolution when the setting is ON', async () => {
    // Positive control. Four assertions above check that the gate refuses; if
    // it refused unconditionally they would all still pass.
    const res = await withTenant(app, actorFor(B), (tx) => requireRecordView(tx));
    expect(res.enabled).toBe(true);
  });
});

describe('RULE-001 — the fail-closed property is structural, not a default', () => {
  it('record_view_enabled has NO column default, in either direction', async () => {
    // settings.ts calls the no-row branch "THE line" and says it is deliberately
    // not a column default, because a default is something a later migration can
    // change without anyone reading that comment.
    //
    // This is that comment turned into a build failure. `DEFAULT true` would
    // open the feature for every tenant that inserts a row without naming the
    // value; `DEFAULT false` would be harmless today but would move the
    // fail-closed decision out of the one place that owns it. Neither is allowed.
    const r = await admin.query(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenant_record_view_setting'
          AND column_name = 'record_view_enabled'`);
    expect(r.rows, 'the column is missing entirely').toHaveLength(1);
    expect(r.rows[0].column_default, 'a default here moves the fail-closed decision').toBeNull();
    // NOT NULL matters for the same reason: a NULL would be a third state, and
    // `row.record_view_enabled === true` would silently resolve it to off while
    // the row claims to be configured.
    expect(r.rows[0].is_nullable).toBe('NO');
  });

  it('the setting store is append-only to the application', async () => {
    // A flip that can be edited afterwards is not evidence of a decision.
    await expect(withTenant(app, actorFor(B), async (tx) => {
      await tx.query(`UPDATE tenant_record_view_setting SET record_view_enabled = true`);
    })).rejects.toThrow(/permission denied/i);

    await expect(withTenant(app, actorFor(B), async (tx) => {
      await tx.query(`DELETE FROM tenant_record_view_setting`);
    })).rejects.toThrow(/permission denied/i);
  });

  it('one tenant switching it ON does not open the feature for another', async () => {
    // Tenant B has been flipped ON by the tests above. Tenant A has never been
    // written. If resolution leaked across tenants, A would now read as ON.
    const bOn = await withTenant(app, actorFor(B), (tx) => postgresRecordViewGate.resolve(tx));
    expect(bOn.enabled, 'fixture: B should be ON by now').toBe(true);

    const a = await withTenant(app, actorFor(A), (tx) => postgresRecordViewGate.resolve(tx));
    expect(a.enabled, 'tenant A read tenant B setting').toBe(false);
    expect(a.source).toBe('unset');
  });
});

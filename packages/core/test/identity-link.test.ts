import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { freshDatabase, adminPool, seedTenant, type SeededTenant } from './setup.js';
import { resolveTenantIdForSigninSlug, withTenantForResolution } from '../src/db.js';
import { resolveRequestContext } from '../src/request-context.js';

/**
 * Sign-in's two database-level guarantees — SEC-01, SEC-02, REQ-031.
 *
 * 1. THE APPLICATION CANNOT CREATE AN IDENTITY LINK. Auto-provisioning is not
 *    prevented by a branch in TypeScript that a later refactor can delete. It is
 *    prevented by a missing grant: `identity_link` has INSERT, UPDATE and DELETE
 *    revoked from `hrms_app` (migration 0005). Somebody who "fixes" the sign-in
 *    handler to create the missing row gets a permission error from PostgreSQL,
 *    not a new employee.
 *
 * 2. THE SIGN-IN ADDRESS SELECTS A TENANT AND GRANTS NOTHING. A subject linked
 *    at one customer resolves to nothing at another customer's address, and the
 *    resolver function answers one yes/no question rather than listing anybody.
 */

const DB = 'hrms_identity_link_test';

let app: pg.Pool;
let admin: pg.Pool;
let northwind: SeededTenant;
let contoso: SeededTenant;

const AISHA_SUBJECT = 'kc-aisha-0001';
const CONTOSO_SUBJECT = 'kc-someone-else-0002';

beforeAll(async () => {
  app = await freshDatabase(DB);
  admin = await adminPool(DB);
  northwind = await seedTenant(admin, { name: 'Northwind', region: 'eu' });
  contoso = await seedTenant(admin, { name: 'Contoso', region: 'in' });

  // Provisioning runs as the OWNER, which is the whole point: this is the only
  // role that can create a link, and it is not the role a request runs as.
  const c = await admin.connect();
  try {
    await c.query(
      `INSERT INTO identity_link (tenant_id, person_id, subject) VALUES ($1,$2,$3)`,
      [northwind.tenantId, northwind.personId, AISHA_SUBJECT]);
    await c.query(
      `INSERT INTO identity_link (tenant_id, person_id, subject) VALUES ($1,$2,$3)`,
      [contoso.tenantId, contoso.personId, CONTOSO_SUBJECT]);
  } finally {
    c.release();
  }
}, 60_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe('the application role cannot auto-provision an identity link', () => {
  it('positive control: the OWNER can insert one', async () => {
    // Without this, every refusal below could be a refusal caused by a broken
    // fixture — a bad tenant id, a missing person — rather than by the grant.
    const c = await admin.connect();
    try {
      await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [northwind.tenantId]);
      const before = await c.query(
        `SELECT count(*)::int AS n FROM identity_link WHERE tenant_id = $1`,
        [northwind.tenantId]);
      await c.query(
        `INSERT INTO identity_link (tenant_id, person_id, subject) VALUES ($1,$2,$3)`,
        [northwind.tenantId, northwind.hrPersonId, 'kc-meera-owner-probe']);
      const after = await c.query(
        `SELECT count(*)::int AS n FROM identity_link WHERE tenant_id = $1`,
        [northwind.tenantId]);
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
      await c.query(`DELETE FROM identity_link WHERE subject = 'kc-meera-owner-probe'`);
    } finally {
      c.release();
    }
  });

  it('refuses INSERT from the application role', async () => {
    await expect(
      withTenantForResolution(app, northwind.tenantId, (tx) =>
        tx.query(
          `INSERT INTO identity_link (tenant_id, person_id, subject) VALUES ($1,$2,$3)`,
          [northwind.tenantId, northwind.hrPersonId, 'kc-autoprovisioned-9999']),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses UPDATE and DELETE from the application role', async () => {
    // Re-pointing an existing link at a different person is auto-provisioning
    // wearing a different hat: the attacker does not need a new row if they can
    // move one.
    await expect(
      withTenantForResolution(app, northwind.tenantId, (tx) =>
        tx.query(`UPDATE identity_link SET person_id = $1 WHERE subject = $2`,
          [northwind.hrPersonId, AISHA_SUBJECT]),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withTenantForResolution(app, northwind.tenantId, (tx) =>
        tx.query(`DELETE FROM identity_link WHERE subject = $1`, [AISHA_SUBJECT]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('leaves the row untouched after all of that', async () => {
    // Asserted through the owner, bypassing RLS and the application role, so
    // the check does not use the same path that was being refused.
    const c = await admin.connect();
    try {
      const r = await c.query(
        `SELECT person_id, disabled_at FROM identity_link WHERE subject = $1`,
        [AISHA_SUBJECT]);
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].person_id).toBe(northwind.personId);
      expect(r.rows[0].disabled_at).toBeNull();
    } finally {
      c.release();
    }
  });
});

describe('resolving a subject inside a tenant', () => {
  it('positive control: Aisha resolves at her own employer', async () => {
    const ctx = await withTenantForResolution(app, northwind.tenantId, (tx) =>
      resolveRequestContext(tx, AISHA_SUBJECT));
    expect(ctx).not.toBeNull();
    expect(ctx!.personId).toBe(northwind.personId);
    expect(ctx!.tenantId).toBe(northwind.tenantId);
  });

  it('resolves to NOTHING for a subject linked at another customer', async () => {
    // The property the sign-in address buys. Contoso's subject is a real,
    // authenticated identity — it just is not anybody at Northwind, and the
    // answer is the same as for a subject that does not exist at all.
    const ctx = await withTenantForResolution(app, northwind.tenantId, (tx) =>
      resolveRequestContext(tx, CONTOSO_SUBJECT));
    expect(ctx).toBeNull();
  });

  it('resolves to NOTHING for a subject nobody has ever linked', async () => {
    const ctx = await withTenantForResolution(app, northwind.tenantId, (tx) =>
      resolveRequestContext(tx, 'kc-total-stranger-0000'));
    expect(ctx).toBeNull();
  });

  it('resolves to NOTHING once the link is disabled', async () => {
    // Disabling is how an ex-employee's login stops working. It must be
    // indistinguishable from never having existed — see REQ-031.
    const c = await admin.connect();
    try {
      await c.query(`UPDATE identity_link SET disabled_at = now() WHERE subject = $1`,
        [CONTOSO_SUBJECT]);
    } finally {
      c.release();
    }
    const ctx = await withTenantForResolution(app, contoso.tenantId, (tx) =>
      resolveRequestContext(tx, CONTOSO_SUBJECT));
    expect(ctx).toBeNull();
  });
});

describe('the readable sign-in address', () => {
  it('resolves an exact label to one tenant id', async () => {
    const id = await resolveTenantIdForSigninSlug(app, northwind.signinSlug);
    expect(id).toBe(northwind.tenantId);
  });

  it('folds case, because host names are case-insensitive', async () => {
    const id = await resolveTenantIdForSigninSlug(app, northwind.signinSlug.toUpperCase());
    expect(id).toBe(northwind.tenantId);
  });

  it('returns null for an address nobody owns', async () => {
    expect(await resolveTenantIdForSigninSlug(app, 'not-a-customer-at-all')).toBeNull();
    expect(await resolveTenantIdForSigninSlug(app, '')).toBeNull();
  });

  it('does not let the application read the tenant list', async () => {
    // The Q-19 ruling accepted that the address space is enumerable from
    // OUTSIDE. It did not make the customer list readable from inside: `tenant`
    // is row-level-secured to the current tenant, and the resolver returns a
    // uuid, never a name or a row.
    const rows = await withTenantForResolution(app, northwind.tenantId, (tx) =>
      tx.query(`SELECT id, name FROM tenant`));
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(northwind.tenantId);
  });

  it('keeps the application role unable to change an address', async () => {
    // A compromised application role must not be able to re-point a customer's
    // sign-in address at itself. Asserted as behaviour, not by reading 0001.
    await expect(
      withTenantForResolution(app, northwind.tenantId, (tx) =>
        tx.query(`UPDATE tenant SET signin_slug = 'stolen' WHERE id = $1`, [northwind.tenantId]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

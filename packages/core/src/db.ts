import pg from 'pg';

/**
 * Tenant context is set TRANSACTION-LOCALLY and read by every RLS policy.
 *
 * Application code must never write `WHERE tenant_id = ?`. If it did, forgetting
 * it once would be the breach. With this design, forgetting it returns zero rows.
 *
 * `set_config(..., true)` makes the setting local to the transaction, so a pooled
 * connection cannot leak one tenant's context into the next request.
 */

/**
 * An `employment.id`, and never anything else.
 *
 * The brand exists because the defect this type replaces was a uuid in the wrong
 * slot: a login account id assigned to a field that erasure, the audit log and
 * the transparency ledger all read as an employment. Both values are uuids, so
 * no compiler complained and no constraint objected. Now a bare string will not
 * assign, and the composite foreign keys added in migration 0002 refuse the
 * wrong value at write time even if someone reaches for a cast.
 */
export type EmploymentId = string & { readonly __employmentId: unique symbol };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only supported way to make an `EmploymentId`. The transport layer calls
 * this once, after it has resolved the caller's login to their employment in
 * this tenant — the resolution is the security-relevant step, and it belongs in
 * one place rather than at every call site.
 */
export function asEmploymentId(value: string): EmploymentId {
  if (!UUID.test(value)) {
    throw new TypeError(`Not an employment id: ${JSON.stringify(value)}`);
  }
  return value as EmploymentId;
}

/**
 * Who is acting. ONE identity, not two.
 *
 * There used to be an `actorId` here alongside a separate `employmentId` on
 * `Principal`. Authorisation read one and the audit log recorded the other, so
 * a manager's change was filed under HR's name and erasure could never find it.
 * Collapsing them to a single field is the fix: there is no second slot to put
 * the wrong value in.
 *
 * An actor with no employment in this tenant cannot act on employment records.
 * That is a deliberate constraint — see the decision log entry of 2026-08-26 —
 * not an oversight. A future non-human actor (an import job, a purge job) needs
 * its own modelled identity, not a nullable column here.
 */
export interface Actor {
  tenantId: string;
  actorEmploymentId: EmploymentId;
}

export type Tx = pg.PoolClient;

export async function withTenant<T>(
  pool: pg.Pool,
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // `true` = transaction-local. Non-negotiable with a connection pool.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', actor.tenantId]);
    // Named for what it holds. `app.actor_id` did not say which kind of id it
    // was, which is how the wrong kind got in.
    await client.query(
      'SELECT set_config($1, $2, true)',
      ['app.actor_employment_id', actor.actorEmploymentId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

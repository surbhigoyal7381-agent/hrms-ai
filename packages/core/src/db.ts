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
export interface Actor {
  tenantId: string;
  actorId: string;
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
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actor.actorId]);
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

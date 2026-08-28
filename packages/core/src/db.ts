import pg from 'pg';

/**
 * Tenant context is set TRANSACTION-LOCALLY and read by every RLS policy.
 *
 * Application code must never write `WHERE tenant_id = ?`. If it did, forgetting
 * it once would be the breach. With this design, forgetting it returns zero rows.
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
 */
export interface Actor {
  tenantId: string;
  actorEmploymentId: EmploymentId;
}

/**
 * LOCK 2 of the four tenant-identity locks
 * (docs/99-decision-log.md, 2026-08-26, one-way door 1).
 *
 * `Tx` used to be `pg.PoolClient`, which handed every caller in this package the
 * raw client. That mattered more than it looked: `client.query(sql)` with no
 * parameters uses PostgreSQL's SIMPLE query protocol, which allows several
 * statements in one string — so one injection defect anywhere could append
 * `; SET app.tenant_id = '<victim>'` and read another customer's data. Row-level
 * security does not help, because the attacker satisfies the policy as somebody
 * else rather than bypassing it.
 *
 * Verified on the installed pg 8.23.0:
 *
 *     params = []            -> ALLOWED  (an empty array is NOT enough)
 *     params = undefined     -> ALLOWED
 *     queryMode 'extended'   -> BLOCKED: cannot insert multiple commands
 *                                        into a prepared statement
 *
 * So `Tx` is now an interface that does not expose the unsafe call at all. The
 * only implementation forces the extended protocol on every statement. This is
 * the type-system half of the countersign condition: the decision log makes
 * "a parameterless query reaching the database outside the wrapper" the trigger
 * to stop deferring per-tenant roles, and a CI grep cannot see a query assembled
 * at runtime. Here there is no reachable path to construct one.
 */
export interface Tx {
  query<R extends pg.QueryResultRow = any>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/** `queryMode` is real in pg 8.23.0 but absent from @types/pg. Narrowly typed here. */
type ExtendedQueryConfig = pg.QueryConfig & { queryMode: 'extended' };

/**
 * Wraps a pooled client so every statement goes through the extended protocol.
 * Not exported: the only way to get a `Tx` is `withTenant`.
 */
function extendedOnly(client: pg.PoolClient): Tx {
  return {
    query<R extends pg.QueryResultRow = any>(text: string, values?: readonly unknown[]) {
      const config = {
        text,
        values: values ? [...values] : undefined,
        queryMode: 'extended',
      } as ExtendedQueryConfig;
      return client.query<R>(config);
    },
  };
}

/**
 * Opens a transaction bound to exactly one tenant.
 *
 * LOCK 3: the tenant is set through `begin_tenant_session`, a SECURITY DEFINER
 * function that refuses a second call in the same transaction. `set_config` is
 * revoked from the application role (LOCK 1) and PL/pgSQL's `USAGE` is revoked so
 * a `DO` block cannot run `EXECUTE 'SET ...'` (LOCK 4) — both in migration 0003.
 * Together: on the legitimate path the tenant is set once and cannot change; on
 * an injected path there is no statement that can change it.
 */
/**
 * A tenant-scoped transaction with NO ACTOR, for the one step that cannot have
 * one: working out who the caller is.
 *
 * The ordinary `withTenant` needs an `Actor`, and the actor is precisely what
 * identity resolution is trying to establish. The tenant comes from the request
 * host — sign-in addresses are tenant-specific already, for REQ-031 — and the
 * subject is then resolved WITHIN that tenant, so a subject belonging to
 * another customer resolves to nothing rather than to a foreign employee.
 *
 * Deliberately narrow, and deliberately awkward to misuse: it hands out a `Tx`
 * but no `Actor`, so nothing that requires one can be called from inside it.
 * Every audit write requires one. If you find yourself wanting an actor here,
 * you are past identity resolution and want `withTenant`.
 */
export async function withTenantForResolution<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const tx = extendedOnly(client);
  try {
    await tx.query('BEGIN');
    // NULL actor: `begin_tenant_session` accepts it, and `app.actor_employment_id`
    // is left empty rather than borrowed from somebody.
    await tx.query('SELECT begin_tenant_session($1, NULL)', [tenantId]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await tx.query('ROLLBACK');
    } catch (rollbackErr) {
      (err as { rollbackError?: unknown }).rollbackError = rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function withTenant<T>(
  pool: pg.Pool,
  actor: Actor,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const tx = extendedOnly(client);
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT begin_tenant_session($1, $2)', [
      actor.tenantId,
      actor.actorEmploymentId,
    ]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    // The rollback must never replace the error that caused it.
    //
    // This was an open MINOR from feature 001, and REQ-014 turns it into a
    // correctness problem: a failed audit write has to reach the alert as
    // itself. If ROLLBACK also fails — a dead connection, usually — the
    // original error still propagates and the rollback failure rides along.
    try {
      await tx.query('ROLLBACK');
    } catch (rollbackErr) {
      (err as { rollbackError?: unknown }).rollbackError = rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Which customer is this request for — the one lookup that happens before any
 * tenant is known.
 *
 * Everything else in this package runs inside `withTenant` or
 * `withTenantForResolution`, both of which need a tenant id before they open.
 * An arriving request has a host name, not a tenant id, and `tenant` is itself
 * row-level-secured with `USING (id = current_tenant())` — so reading it
 * requires already knowing the answer.
 *
 * `tenant_id_for_signin_slug` (migration 0006) is the SECURITY DEFINER way
 * through, and it is deliberately narrow: it returns ONE uuid for an exact
 * label, and no name, no region, no row and no listing.
 *
 * This function hands back a uuid, never a `Tx`. That is the point. A helper
 * that returned a transaction with no tenant set would be a hole straight
 * through the four locks of docs/99-decision-log.md — every RLS policy would
 * see an empty `app.tenant_id` and the caller would be one forgotten line away
 * from a cross-tenant read. There is nothing to forget here, because there is
 * nothing to hold.
 */
export async function resolveTenantIdForSigninSlug(
  pool: pg.Pool,
  slug: string,
): Promise<string | null> {
  if (typeof slug !== 'string' || slug.trim().length === 0) return null;
  const client = await pool.connect();
  try {
    const tx = extendedOnly(client);
    const r = await tx.query<{ tenant_id: string | null }>(
      'SELECT tenant_id_for_signin_slug($1) AS tenant_id',
      [slug],
    );
    return r.rows[0]?.tenant_id ?? null;
  } finally {
    client.release();
  }
}

/**
 * The application's connection pool.
 *
 * Built here rather than in `apps/web` so the transport layer never imports the
 * database driver. That boundary is the reason `apps/web` holds no SQL: a layer
 * that cannot reach `pg` cannot open a connection outside the wrapper, and the
 * wrapper is what forces the extended query protocol that LOCK 2 depends on.
 *
 * The connection string names `hrms_app`, a NOBYPASSRLS role. Connecting as the
 * owner would silently disable every row-level-security policy in the product —
 * `FORCE ROW LEVEL SECURITY` protects against the owner, but only the table
 * owner, and a superuser bypasses everything.
 */
export type AppPool = pg.Pool;

export function createAppPool(connectionString: string, max = 10): AppPool {
  if (typeof connectionString !== 'string' || connectionString.trim().length === 0) {
    throw new TypeError('createAppPool needs a connection string.');
  }
  return new pg.Pool({ connectionString, max });
}

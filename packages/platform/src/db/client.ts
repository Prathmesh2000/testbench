import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema';

// COUNT(*) and other bigint results arrive as strings by default. Every count we produce fits easily
// in a JS number, and callers should not have to remember to parse them.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string, max = 20): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max }) }),
  });
}

export interface TenantContext {
  orgId: string;
  userId: string;
  /** Where the change comes from (web, api, mcp, slack); stamped on outbox events for the audit log. */
  source?: string;
}

/**
 * Runs `fn` in a transaction scoped to one organisation. Every RLS policy reads app.org_id, so this is
 * the only way application code should touch tenant tables.
 *
 * set_config(..., true) is transaction-local: the value disappears at COMMIT/ROLLBACK, so a pooled
 * connection can never leak one tenant's context into the next request that borrows it.
 */
export function withTenant<T>(db: Db, ctx: TenantContext, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId}, true),
                     set_config('app.source', ${ctx.source ?? ''}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Like withTenant, but before an organisation is chosen: only the user's own memberships are visible. */
export function withUser<T>(db: Db, userId: string, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.user_id', ${userId}, true)`.execute(trx);
    return fn(trx);
  });
}

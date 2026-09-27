import { sql } from 'kysely';
import { withTenant, type Db, type Tx } from './db/client';

export interface OutboxEvent {
  id: string;
  type: string;
  orgId: string;
  projectId: string | null;
  actor: string | null;
  occurredAt: Date;
  data: Record<string, unknown>;
  /** web, api, mcp or slack: where the change came from. */
  source: string;
}

/**
 * Reacts to domain events. `handle` runs inside a tenant transaction for the event's organisation,
 * and the relay records the event as processed in that same transaction, so a consumer's database
 * effects happen exactly once even though delivery is at least once. Side effects outside the database
 * (such as indexing a document) may repeat and must be safe to repeat.
 */
export interface Consumer {
  name: string;
  types: readonly string[];
  handle(trx: Tx, event: OutboxEvent): Promise<void>;
}

// Tenant transactions need a user id for RLS on memberships; system work has none.
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

interface Log {
  error(obj: object, msg: string): void;
}

interface ClaimedRow {
  id: string;
  type: string;
  org_id: string;
  project_id: string | null;
  actor: string | null;
  occurred_at: Date;
  data: Record<string, unknown>;
  source: string;
}

/** Delivers one batch of pending events. Returns how many were claimed, so callers know whether to idle. */
export async function relayBatch(
  db: Db,
  consumers: readonly Consumer[],
  log: Log,
  batch = 100,
): Promise<number> {
  const { rows } = await sql<ClaimedRow>`SELECT * FROM outbox.claim_events(${batch})`.execute(db);
  for (const row of rows) {
    const event: OutboxEvent = {
      id: row.id,
      type: row.type,
      orgId: row.org_id,
      projectId: row.project_id,
      actor: row.actor,
      occurredAt: row.occurred_at,
      data: row.data,
      source: row.source,
    };
    let error: string | null = null;
    for (const consumer of consumers) {
      if (!consumer.types.includes(event.type)) continue;
      try {
        await withTenant(db, { orgId: event.orgId, userId: event.actor ?? SYSTEM_USER }, async (trx) => {
          const fresh = await trx
            .insertInto('outbox.processed')
            .values({ consumer: consumer.name, event_id: event.id, org_id: event.orgId })
            .onConflict((oc) => oc.doNothing())
            .returning('event_id')
            .executeTakeFirst();
          if (fresh) await consumer.handle(trx, event);
        });
      } catch (err) {
        // Keep going with the other consumers; the event is retried later and consumers that already
        // succeeded skip it thanks to their processed row.
        error = `${consumer.name}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(
          { err, eventId: event.id, type: event.type, consumer: consumer.name },
          'event consumer failed',
        );
      }
    }
    await sql`SELECT outbox.finish_event(${event.id}, ${error})`.execute(db);
  }
  return rows.length;
}

/** Polls the outbox until stopped. Runs in every core-api process; claims make that safe. */
export function startOutboxRelay(
  db: Db,
  consumers: readonly Consumer[],
  log: Log,
  idleMs = 500,
): () => Promise<void> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const claimed = await relayBatch(db, consumers, log);
        if (claimed === 0) await new Promise((r) => setTimeout(r, idleMs));
      } catch (err) {
        log.error({ err }, 'outbox relay failed; retrying');
        await new Promise((r) => setTimeout(r, idleMs * 10));
      }
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

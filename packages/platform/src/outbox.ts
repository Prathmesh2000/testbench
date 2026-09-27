import { randomUUID } from 'node:crypto';
import type { EventType } from '@tb/contracts';
import type { Tx } from './db/client';

export interface NewEvent {
  type: EventType;
  orgId: string;
  projectId: string | null;
  actor: string | null;
  data: Record<string, unknown>;
  version?: number;
}

/**
 * Appends a domain event to the outbox inside the caller's transaction, so the event is stored exactly
 * when the change it describes commits. Takes a transaction, not a database handle, on purpose.
 */
export async function recordEvent(trx: Tx, event: NewEvent): Promise<void> {
  await trx
    .insertInto('outbox.event')
    .values({
      id: randomUUID(),
      org_id: event.orgId,
      project_id: event.projectId,
      type: event.type,
      actor: event.actor,
      occurred_at: new Date(),
      version: event.version ?? 1,
      data: JSON.stringify(event.data),
    })
    .execute();
}

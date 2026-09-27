import { z } from 'zod';

/**
 * Envelope shared by every domain event (HLD §4). Consumers deduplicate on `id`, because the relay
 * delivers at least once. `version` is the schema version of `data`, bumped on breaking changes.
 */
export const EventEnvelope = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/),
  org_id: z.uuid(),
  project_id: z.uuid().nullable(),
  actor: z.uuid().nullable(),
  occurred_at: z.iso.datetime(),
  version: z.number().int().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const EVENT_TYPES = [
  'testcase.created',
  'testcase.updated',
  'testcase.bulk_updated',
  'run.created',
  'result.recorded',
  'user.role_changed',
  'run.prepared',
  'defect.created',
  'defect.linked',
  'defect.status_changed',
  'retest.completed',
  'document.versioned',
  'document.created',
  'release.signed_off',
  'member.invited',
  'member.removed',
  'role.saved',
  'role.deleted',
  'token.created',
  'token.revoked',
  'ai.config_changed',
  'board.created',
  'meeting.scheduled',
  'action_item.converted',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

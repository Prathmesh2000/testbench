import {
  ActionItemBody,
  ActionItemPatch,
  ConvertBody,
  CreateCaseBody,
  MeetingBody,
  type ActionItem,
  type MeetingDetail,
  type MeetingRow,
} from '@tb/contracts';
import { createBoard } from '@tb/collab';
import { projectTx } from '@tb/iam';
import { conflict, notFound, recordEvent, type ServiceDeps, type Tx } from '@tb/platform';
import { createCase } from '@tb/repository';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const Project = z.object({ projectId: z.uuid() });
const Meeting = Project.extend({ meetingId: z.uuid() });
const Item = Meeting.extend({ itemId: z.uuid() });

async function people(trx: Tx, ids: string[]) {
  if (!ids.length) return [];
  return trx.selectFrom('iam.app_user').select(['id', 'name', 'email']).where('id', 'in', ids).execute();
}

async function findMeeting(trx: Tx, projectId: string, meetingId: string) {
  const m = await trx
    .selectFrom('meet.meeting')
    .selectAll()
    .where('id', '=', meetingId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!m) throw notFound('Meeting');
  return m;
}

async function actionItems(trx: Tx, meetingId: string): Promise<ActionItem[]> {
  const rows = await trx
    .selectFrom('meet.action_item as a')
    .leftJoin('iam.app_user as u', 'u.id', 'a.assignee_id')
    .select(['a.id', 'a.text', 'a.status', 'a.converted_to', 'a.created_at', 'u.id as uid', 'u.name'])
    .where('a.meeting_id', '=', meetingId)
    .orderBy('a.created_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    assignee: r.uid ? { id: r.uid, name: r.name! } : null,
    status: r.status as ActionItem['status'],
    convertedTo: r.converted_to,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Meetings (HLD §5.9): scheduled with a calendar invite, notes kept in a live document, and action
 * items that become test cases or tasks.
 */
export const meetingRoutes: FastifyPluginAsync<ServiceDeps & { calendarUrl: string | null }> = async (
  app,
  { db, calendarUrl },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const actor = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

  r.get(
    '/projects/:projectId/meetings',
    { schema: { params: Project } },
    async (req): Promise<MeetingRow[]> =>
      projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        const rows = await trx
          .selectFrom('meet.meeting as m')
          .select((eb) => [
            'm.id',
            'm.title',
            'm.starts_at',
            'm.minutes',
            'm.context',
            'm.attendees',
            eb
              .selectFrom('meet.action_item as a')
              .select(eb.fn.countAll<number>().as('n'))
              .whereRef('a.meeting_id', '=', 'm.id')
              .where('a.status', '=', 'open')
              .as('open_items'),
          ])
          .where('m.project_id', '=', req.params.projectId)
          .orderBy('m.starts_at', 'desc')
          .limit(200)
          .execute();
        const everyone = new Map(
          (await people(trx, [...new Set(rows.flatMap((m) => m.attendees))])).map((p) => [p.id, p]),
        );
        return rows.map((m) => ({
          id: m.id,
          title: m.title,
          startsAt: m.starts_at.toISOString(),
          minutes: m.minutes,
          context: m.context,
          attendees: m.attendees.flatMap((id) =>
            everyone.has(id) ? [{ id, name: everyone.get(id)!.name }] : [],
          ),
          openItems: Number(m.open_items ?? 0),
        }));
      }),
  );

  r.post(
    '/projects/:projectId/meetings',
    { schema: { params: Project, body: MeetingBody } },
    async (req, reply) => {
      const b = req.body;
      const { id, invitees } = await projectTx(db, req, req.params.projectId, 'case.write', async (trx) => {
        const attendees = [...new Set([req.auth.userId, ...b.attendeeIds])];
        const found = await people(trx, attendees);
        if (found.length !== attendees.length) throw notFound('Attendee');
        const notes = await createBoard(trx, actor(req), req.params.projectId, 'doc', `Notes: ${b.title}`);
        const m = await trx
          .insertInto('meet.meeting')
          .values({
            org_id: req.auth.orgId,
            project_id: req.params.projectId,
            title: b.title,
            starts_at: b.startsAt,
            minutes: b.minutes,
            attendees,
            context: b.context ?? null,
            notes_board: notes,
            created_by: req.auth.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await recordEvent(trx, {
          type: 'meeting.scheduled',
          orgId: req.auth.orgId,
          projectId: req.params.projectId,
          actor: req.auth.userId,
          data: { meeting_id: m.id, title: b.title, starts_at: b.startsAt },
        });
        return { id: m.id, invitees: found };
      });
      // The invite goes out after the meeting exists; a calendar outage leaves the meeting without an
      // invite rather than failing it, and the meeting page says which calendar holds it.
      if (calendarUrl) {
        try {
          const res = await fetch(`${calendarUrl}/events`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title: b.title,
              start: b.startsAt,
              minutes: b.minutes,
              attendees: invitees.map((p) => p.email),
              context: b.context,
            }),
            signal: AbortSignal.timeout(5_000),
          });
          const eventId = ((await res.json().catch(() => ({}))) as { id?: string }).id ?? null;
          await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
            trx.updateTable('meet.meeting').set({ calendar_id: eventId }).where('id', '=', id).execute(),
          );
        } catch (err) {
          req.log.warn({ err }, 'calendar invite failed');
        }
      }
      return reply.status(201).send({ id });
    },
  );

  r.get(
    '/projects/:projectId/meetings/:meetingId',
    { schema: { params: Meeting } },
    async (req): Promise<MeetingDetail> =>
      projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        const m = await findMeeting(trx, req.params.projectId, req.params.meetingId);
        const attendees = await people(trx, m.attendees);
        const items = await actionItems(trx, m.id);
        return {
          id: m.id,
          title: m.title,
          startsAt: m.starts_at.toISOString(),
          minutes: m.minutes,
          context: m.context,
          attendees: attendees.map((p) => ({ id: p.id, name: p.name })),
          openItems: items.filter((i) => i.status === 'open').length,
          notesBoardId: m.notes_board,
          calendar: m.calendar_id ? `${m.calendar} · ${m.calendar_id}` : 'no invite sent',
          actionItems: items,
        };
      }),
  );

  r.post(
    '/projects/:projectId/meetings/:meetingId/items',
    { schema: { params: Meeting, body: ActionItemBody } },
    async (req, reply) =>
      reply.status(201).send(
        await projectTx(db, req, req.params.projectId, 'case.write', async (trx) => {
          await findMeeting(trx, req.params.projectId, req.params.meetingId);
          return trx
            .insertInto('meet.action_item')
            .values({
              org_id: req.auth.orgId,
              meeting_id: req.params.meetingId,
              text: req.body.text,
              assignee_id: req.body.assigneeId,
              created_by: req.auth.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
        }),
      ),
  );

  r.patch(
    '/projects/:projectId/meetings/:meetingId/items/:itemId',
    { schema: { params: Item, body: ActionItemPatch } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', async (trx) => {
        await findMeeting(trx, req.params.projectId, req.params.meetingId);
        const updated = await trx
          .updateTable('meet.action_item')
          .set({ status: req.body.status })
          .where('id', '=', req.params.itemId)
          .where('meeting_id', '=', req.params.meetingId)
          .where('status', '<>', 'converted')
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw notFound('Open action item');
      });
      return reply.status(204).send();
    },
  );

  r.delete(
    '/projects/:projectId/meetings/:meetingId/items/:itemId',
    { schema: { params: Item } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', async (trx) => {
        await findMeeting(trx, req.params.projectId, req.params.meetingId);
        await trx
          .deleteFrom('meet.action_item')
          .where('id', '=', req.params.itemId)
          .where('meeting_id', '=', req.params.meetingId)
          .execute();
      });
      return reply.status(204).send();
    },
  );

  /** Turns an action item into a draft test case (text as title, meeting as context) or marks it a task. */
  r.post(
    '/projects/:projectId/meetings/:meetingId/items/:itemId/convert',
    { schema: { params: Item, body: ConvertBody } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'case.write', async (trx) => {
        const m = await findMeeting(trx, req.params.projectId, req.params.meetingId);
        // Row lock so two people converting the same item at once don't create two cases.
        const item = await trx
          .selectFrom('meet.action_item')
          .selectAll()
          .where('id', '=', req.params.itemId)
          .where('meeting_id', '=', m.id)
          .forUpdate()
          .executeTakeFirst();
        if (!item) throw notFound('Action item');
        if (item.status === 'converted') throw conflict(`Already converted to ${item.converted_to}.`);
        let convertedTo = 'task';
        if (req.body.to === 'case') {
          const c = await createCase(
            trx,
            actor(req),
            req.params.projectId,
            CreateCaseBody.parse({
              title: item.text.length >= 3 ? item.text.slice(0, 300) : `Follow up: ${item.text}`,
              moduleId: req.body.moduleId,
              priority: req.body.priority,
              preconditions: `From meeting "${m.title}" on ${m.starts_at.toISOString().slice(0, 10)}${m.context ? ` about ${m.context}` : ''}.`,
              ownerId: item.assignee_id,
              labels: ['from-meeting'],
            }),
          );
          convertedTo = `case:${c.key}`;
        }
        await trx
          .updateTable('meet.action_item')
          .set({ status: 'converted', converted_to: convertedTo })
          .where('id', '=', item.id)
          .execute();
        await recordEvent(trx, {
          type: 'action_item.converted',
          orgId: req.auth.orgId,
          projectId: req.params.projectId,
          actor: req.auth.userId,
          data: {
            item_id: item.id,
            meeting_id: m.id,
            converted_to: convertedTo,
            text: item.text.slice(0, 200),
          },
        });
        return { convertedTo };
      }),
  );
};

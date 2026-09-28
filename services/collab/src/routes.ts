import { BOARD_KINDS, BoardBody, type BoardKind, type BoardRow, type CollabTicket } from '@tb/contracts';
import { projectTx, requirePermission } from '@tb/iam';
import { AppError, notFound, recordEvent, signCollabTicket, type ServiceDeps, type Tx } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

const Project = z.object({ projectId: z.uuid() });
const Board = Project.extend({ boardId: z.uuid() });
// Long enough to connect; the collaboration server keeps an open connection alive after that.
const TICKET_TTL_S = 120;

export interface CollabOptions {
  url: string;
  secret: string | null;
}

/** Creates a board row; also used by meetings for their notes document. */
export async function createBoard(
  trx: Tx,
  actor: { orgId: string; userId: string },
  projectId: string,
  kind: BoardKind,
  title: string,
): Promise<string> {
  const row = await trx
    .insertInto('collab.board')
    .values({ org_id: actor.orgId, project_id: projectId, kind, title, created_by: actor.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await recordEvent(trx, {
    type: 'board.created',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { board_id: row.id, kind, title },
  });
  return row.id;
}

/**
 * Boards (HLD §5.9). The content itself lives on the collaboration server as a Yjs document; this
 * module owns the list, the metadata and who may open a board, which it hands out as signed tickets.
 */
export const collabRoutes: FastifyPluginAsync<ServiceDeps & { collab: CollabOptions }> = async (
  app,
  { db, collab },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/projects/:projectId/boards',
    { schema: { params: Project, querystring: z.object({ kind: z.enum(BOARD_KINDS).optional() }) } },
    async (req): Promise<BoardRow[]> =>
      projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        let q = trx
          .selectFrom('collab.board as b')
          .innerJoin('iam.app_user as u', 'u.id', 'b.created_by')
          .select(['b.id', 'b.kind', 'b.title', 'b.updated_at', 'u.name'])
          .where('b.project_id', '=', req.params.projectId)
          .where('b.archived', '=', false)
          // Meeting notes are reached from their meeting, not listed among boards.
          .where((eb) =>
            eb.not(
              eb.exists(
                eb.selectFrom('meet.meeting as m').select('m.id').whereRef('m.notes_board', '=', 'b.id'),
              ),
            ),
          )
          .orderBy('b.updated_at', 'desc')
          .limit(500);
        if (req.query.kind) q = q.where('b.kind', '=', req.query.kind);
        return (await q.execute()).map((b) => ({
          id: b.id,
          kind: b.kind as BoardKind,
          title: b.title,
          createdBy: b.name,
          updatedAt: b.updated_at.toISOString(),
        }));
      }),
  );

  r.post(
    '/projects/:projectId/boards',
    { schema: { params: Project, body: BoardBody } },
    async (req, reply) => {
      const id = await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        createBoard(trx, req.auth, req.params.projectId, req.body.kind, req.body.title),
      );
      return reply.status(201).send({ id });
    },
  );

  r.patch(
    '/projects/:projectId/boards/:boardId',
    {
      schema: {
        params: Board,
        body: z.object({
          title: z.string().trim().min(1).max(200).optional(),
          archived: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', async (trx) => {
        const updated = await trx
          .updateTable('collab.board')
          .set({ ...req.body, updated_at: new Date() })
          .where('id', '=', req.params.boardId)
          .where('project_id', '=', req.params.projectId)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw notFound('Board');
      });
      return reply.status(204).send();
    },
  );

  r.get(
    '/projects/:projectId/boards/:boardId',
    { schema: { params: Board } },
    async (req): Promise<BoardRow> =>
      projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        const b = await trx
          .selectFrom('collab.board as b')
          .innerJoin('iam.app_user as u', 'u.id', 'b.created_by')
          .select(['b.id', 'b.kind', 'b.title', 'b.updated_at', 'u.name'])
          .where('b.id', '=', req.params.boardId)
          .where('b.project_id', '=', req.params.projectId)
          .executeTakeFirst();
        if (!b) throw notFound('Board');
        return {
          id: b.id,
          kind: b.kind as BoardKind,
          title: b.title,
          createdBy: b.name,
          updatedAt: b.updated_at.toISOString(),
        };
      }),
  );

  /** A ticket for the collaboration server. Viewers get read-only tickets; editing needs case.write. */
  r.post(
    '/projects/:projectId/boards/:boardId/ticket',
    { schema: { params: Board } },
    async (req): Promise<CollabTicket> => {
      if (!collab.secret)
        throw new AppError(503, 'collab_unavailable', 'Live boards need COLLAB_SECRET to be configured.');
      await projectTx(db, req, req.params.projectId, 'case.read', async (trx) => {
        const b = await trx
          .selectFrom('collab.board')
          .select('id')
          .where('id', '=', req.params.boardId)
          .where('project_id', '=', req.params.projectId)
          .executeTakeFirst();
        if (!b) throw notFound('Board');
      });
      let canEdit = true;
      try {
        requirePermission(req, req.params.projectId, 'case.write');
      } catch {
        canEdit = false;
      }
      const token = signCollabTicket(collab.secret, {
        board: req.params.boardId,
        org: req.auth.orgId,
        user: req.auth.userId,
        name: req.auth.name,
        canEdit,
        exp: Math.floor(Date.now() / 1000) + TICKET_TTL_S,
      });
      return { url: collab.url, token, canEdit, user: { id: req.auth.userId, name: req.auth.name } };
    },
  );
};

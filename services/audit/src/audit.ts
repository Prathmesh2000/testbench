import { AUDIT_SOURCES, AuditQuery, EVENT_TYPES, type AuditPage, type AuditRow } from '@tb/contracts';
import { orgTx } from '@tb/iam';
import { badRequest, type Consumer, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { summarise } from './summarise';

/**
 * The audit log (HLD §8): every domain event, from every service, becomes one append-only entry with
 * who, when, where from, and a readable summary. It runs as an outbox consumer, so an entry exists
 * exactly when the change it describes committed.
 */
export const auditConsumer: Consumer = {
  name: 'audit',
  types: EVENT_TYPES,
  async handle(trx, e) {
    const s = summarise(e.type, e.data);
    await trx
      .insertInto('audit.entry')
      .values({
        id: e.id,
        org_id: e.orgId,
        project_id: e.projectId,
        at: e.occurredAt,
        actor_id: e.actor,
        source: e.source,
        action: s.action,
        entity: s.entity,
        details: s.details,
        data: JSON.stringify({ type: e.type, ...e.data }),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  },
};

// Keyset cursor over (at, id), newest first: "<iso>|<uuid>".
const encode = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decode(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at))) throw badRequest('Invalid cursor');
  return { at, id };
}

export const auditRoutes: FastifyPluginAsync<ServiceDeps> = async (app, { db }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/admin/audit', { schema: { querystring: AuditQuery } }, async (req): Promise<AuditPage> =>
    orgTx(db, req, 'audit.read', async (trx) => {
      const q = req.query;
      let query = trx
        .selectFrom('audit.entry as a')
        .leftJoin('iam.app_user as u', 'u.id', 'a.actor_id')
        .leftJoin('repo.project as p', 'p.id', 'a.project_id')
        .select(['a.id', 'a.at', 'a.source', 'a.action', 'a.entity', 'a.details', 'u.name', 'p.key'])
        .orderBy('a.at', 'desc')
        .orderBy('a.id', 'desc')
        .limit(q.limit + 1);
      if (q.actorId) query = query.where('a.actor_id', '=', q.actorId);
      if (q.source) query = query.where('a.source', '=', q.source);
      if (q.from) query = query.where('a.at', '>=', new Date(q.from));
      if (q.to) query = query.where('a.at', '<', new Date(q.to));
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query = query.where((eb) =>
          eb.or([
            eb('a.action', 'ilike', like),
            eb('a.entity', 'ilike', like),
            eb('a.details', 'ilike', like),
          ]),
        );
      }
      if (q.cursor) {
        const c = decode(q.cursor);
        query = query.where(sql<boolean>`(a.at, a.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
      }
      const rows = await query.execute();
      const page = rows.slice(0, q.limit);
      const items: AuditRow[] = page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.name,
        source: (AUDIT_SOURCES as readonly string[]).includes(r.source)
          ? (r.source as AuditRow['source'])
          : 'web',
        action: r.action,
        entity: r.entity,
        details: r.details,
        project: r.key,
      }));
      const last = page.at(-1);
      return { items, next: rows.length > q.limit && last ? encode(last.at, last.id) : null };
    }),
  );
};

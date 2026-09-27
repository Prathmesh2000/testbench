import {
  CHANNELS,
  ChannelBody,
  NOTIFY_EVENT_TYPES,
  PreferencesBody,
  RuleBody,
  TemplateBody,
  type InboxItem,
  type NotifyEvent,
} from '@tb/contracts';
import { projectTx } from '@tb/iam';
import type { ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { NotifyClient } from './client';

const Project = z.object({ projectId: z.uuid() });
const EventChannel = Project.extend({
  event: z.enum(NOTIFY_EVENT_TYPES as [NotifyEvent, ...NotifyEvent[]]),
  channel: z.enum(CHANNELS),
});

/**
 * The web app's view of the notification service. Personal routes (inbox, preferences) act only on the
 * caller's own recipient id. The console routes change organisation-wide behaviour, so they require
 * project.manage (project admins and org admins), checked against the project the caller is in.
 */
export const notifyRoutes: FastifyPluginAsync<ServiceDeps & { client: NotifyClient }> = async (
  app,
  { db, client },
) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tenant = (req: FastifyRequest) => req.auth.orgId;
  const me = (req: FastifyRequest) => encodeURIComponent(req.auth.userId);

  // ---------- personal ----------
  r.get('/me/notifications', async (req) => {
    const items = await client.request<InboxItem[]>(tenant(req), 'GET', `/v1/inbox/${me(req)}`);
    return { items, unread: items.filter((i) => !i.read).length };
  });
  r.post(
    '/me/notifications/read',
    { schema: { body: z.object({ ids: z.array(z.string().max(200)).max(200) }) } },
    async (req, reply) => {
      await client.request(tenant(req), 'POST', `/v1/inbox/${me(req)}/read`, req.body);
      return reply.status(204).send();
    },
  );
  r.get('/me/notification-preferences', async (req) =>
    client.request(tenant(req), 'GET', `/v1/preferences/${me(req)}`),
  );
  r.put('/me/notification-preferences', { schema: { body: PreferencesBody } }, async (req, reply) => {
    await client.request(tenant(req), 'PUT', `/v1/preferences/${me(req)}`, req.body);
    return reply.status(204).send();
  });

  // ---------- console (admins) ----------
  const admin = <T>(
    req: FastifyRequest<{ Params: { projectId: string } }>,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    projectTx(db, req, req.params.projectId, 'project.manage', () =>
      client.request<T>(tenant(req), method, path, body),
    );

  r.get('/projects/:projectId/notify/rules', { schema: { params: Project } }, async (req) =>
    admin(req, 'GET', '/v1/rules'),
  );
  r.post(
    '/projects/:projectId/notify/rules',
    { schema: { params: Project, body: RuleBody } },
    async (req, reply) => reply.status(201).send(await admin(req, 'POST', '/v1/rules', req.body)),
  );
  r.put(
    '/projects/:projectId/notify/rules/:id',
    { schema: { params: Project.extend({ id: z.uuid() }), body: RuleBody } },
    async (req) => admin(req, 'PUT', `/v1/rules/${req.params.id}`, req.body),
  );
  r.delete(
    '/projects/:projectId/notify/rules/:id',
    { schema: { params: Project.extend({ id: z.uuid() }) } },
    async (req, reply) => {
      await admin(req, 'DELETE', `/v1/rules/${req.params.id}`);
      return reply.status(204).send();
    },
  );

  r.get('/projects/:projectId/notify/templates', { schema: { params: Project } }, async (req) =>
    admin(req, 'GET', '/v1/templates'),
  );
  r.put(
    '/projects/:projectId/notify/templates/:event/:channel',
    { schema: { params: EventChannel, body: TemplateBody } },
    async (req, reply) => {
      await admin(req, 'PUT', `/v1/templates/${req.params.event}/${req.params.channel}`, req.body);
      return reply.status(204).send();
    },
  );
  r.delete(
    '/projects/:projectId/notify/templates/:event/:channel',
    { schema: { params: EventChannel } },
    async (req, reply) => {
      await admin(req, 'DELETE', `/v1/templates/${req.params.event}/${req.params.channel}`);
      return reply.status(204).send();
    },
  );
  r.post(
    '/projects/:projectId/notify/templates/preview',
    {
      schema: {
        params: Project,
        body: z.object({
          event: EventChannel.shape.event,
          channel: EventChannel.shape.channel,
          subject: z.string().max(300),
          body: z.string().max(5000),
        }),
      },
    },
    async (req) => admin(req, 'POST', '/v1/templates/preview', req.body),
  );

  r.get('/projects/:projectId/notify/channels', { schema: { params: Project } }, async (req) =>
    admin(req, 'GET', '/v1/channels'),
  );
  r.put(
    '/projects/:projectId/notify/channels/:channel',
    { schema: { params: Project.extend({ channel: z.enum(CHANNELS) }), body: ChannelBody } },
    async (req, reply) => {
      await admin(req, 'PUT', `/v1/channels/${req.params.channel}`, req.body);
      return reply.status(204).send();
    },
  );
  r.post(
    '/projects/:projectId/notify/channels/:channel/test',
    { schema: { params: Project.extend({ channel: z.enum(CHANNELS) }) } },
    async (req, reply) =>
      reply.status(202).send(
        await admin(req, 'POST', `/v1/channels/${req.params.channel}/test`, {
          recipient: { id: req.auth.userId, name: req.auth.name, email: req.auth.email },
          sentBy: req.auth.name,
        }),
      ),
  );

  r.get('/projects/:projectId/notify/deliveries', { schema: { params: Project } }, async (req) =>
    admin(req, 'GET', '/v1/deliveries?limit=300'),
  );
  r.post(
    '/projects/:projectId/notify/deliveries/resend',
    { schema: { params: Project, body: z.object({ id: z.string().min(10).max(200) }) } },
    async (req, reply) => reply.status(202).send(await admin(req, 'POST', '/v1/deliveries/resend', req.body)),
  );
};

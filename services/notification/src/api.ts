import { timingSafeEqual } from 'node:crypto';
import {
  CHANNELS,
  ChannelBody,
  NOTIFY_EVENT_TYPES,
  NotifyRequest,
  PreferencesBody,
  RuleBody,
  TEAM_CHANNELS,
  TemplateBody,
  type Channel,
  type ChannelConfig,
  type NotifyEvent,
  type TeamChannel,
  type Template,
} from '@tb/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ConditionError, parseCondition } from './condition';
import { checkWebhookTarget, parsePhoneNumbers } from './senders';
import { ingest, renderMessage, resend, sampleData, templateFor, type Deps } from './service';

interface ApiOptions extends Deps {
  /** Shared secret for callers (core-api). Per-tenant API keys come when the service is sold on its own. */
  serviceKey: string;
  allowLocalTargets: boolean;
}

const sameSecret = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const TENANT = /^[A-Za-z0-9-]{8,64}$/;

/** Webhook URLs are credentials: show only enough to recognise which one is set. */
function maskTarget(channel: Channel, target: string | undefined): string | null {
  if (!target) return null;
  if (channel === 'sms')
    return target
      .split(',')
      .map((n) => `${n.trim().slice(0, 4)}…${n.trim().slice(-2)}`)
      .join(', ');
  if (channel === 'email') return target;
  try {
    const u = new URL(target);
    return `${u.host}/…${u.pathname.slice(-4)}`;
  } catch {
    return '…';
  }
}

export const notificationApi: FastifyPluginAsync<ApiOptions> = async (app, opts) => {
  const deps: Deps = opts;
  const r = app.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply
        .status(400)
        .send({
          error: {
            code: 'invalid_request',
            message: 'Some fields are missing or invalid',
            details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
          },
        });
    }
    if (err instanceof ConditionError)
      return reply.status(400).send({ error: { code: 'invalid_condition', message: err.message } });
    req.log.error({ err }, 'unhandled error');
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Something went wrong on our side. Try again.' } });
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/v1/health') return;
    const key = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const tenant = req.headers['x-tenant-id'];
    if (!sameSecret(key, opts.serviceKey))
      return reply
        .status(401)
        .send({ error: { code: 'unauthenticated', message: 'Missing or wrong service key' } });
    if (typeof tenant !== 'string' || !TENANT.test(tenant))
      return reply.status(400).send({ error: { code: 'bad_tenant', message: 'X-Tenant-Id is required' } });
  });
  const tenantOf = (req: { headers: Record<string, unknown> }) => req.headers['x-tenant-id'] as string;

  app.get('/v1/health', async () => ({ ok: true }));

  r.post('/v1/notify', { schema: { body: NotifyRequest } }, async (req, reply) => {
    const result = await ingest(deps, tenantOf(req), req.body);
    return reply.status(result.duplicate ? 200 : 202).send(result);
  });

  // ---------- rules ----------
  r.get('/v1/rules', async (req) => deps.store.rules(tenantOf(req)));
  const saveRule = async (tenant: string, id: string | null, body: z.infer<typeof RuleBody>) => {
    parseCondition(body.condition); // reject a condition that could never be evaluated
    return deps.store.saveRule(tenant, id, body);
  };
  r.post('/v1/rules', { schema: { body: RuleBody } }, async (req, reply) =>
    reply.status(201).send(await saveRule(tenantOf(req), null, req.body)),
  );
  r.put('/v1/rules/:id', { schema: { params: z.object({ id: z.uuid() }), body: RuleBody } }, async (req) =>
    saveRule(tenantOf(req), req.params.id, req.body),
  );
  r.delete('/v1/rules/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    await deps.store.deleteRule(tenantOf(req), req.params.id);
    return reply.status(204).send();
  });

  // ---------- templates ----------
  const EventChannel = z.object({
    event: z.enum(NOTIFY_EVENT_TYPES as [NotifyEvent, ...NotifyEvent[]]),
    channel: z.enum(CHANNELS),
  });
  r.get('/v1/templates', async (req) => {
    const out: Template[] = [];
    for (const event of NOTIFY_EVENT_TYPES)
      for (const channel of CHANNELS) out.push(await templateFor(deps.store, tenantOf(req), event, channel));
    return out;
  });
  r.put(
    '/v1/templates/:event/:channel',
    { schema: { params: EventChannel, body: TemplateBody } },
    async (req, reply) => {
      await deps.store.saveTemplate(tenantOf(req), req.params.event, req.params.channel, req.body);
      return reply.status(204).send();
    },
  );
  r.delete('/v1/templates/:event/:channel', { schema: { params: EventChannel } }, async (req, reply) => {
    await deps.store.saveTemplate(tenantOf(req), req.params.event, req.params.channel, null);
    return reply.status(204).send();
  });
  r.post(
    '/v1/templates/preview',
    { schema: { body: EventChannel.extend({ subject: z.string().max(300), body: z.string().max(5000) }) } },
    async (req) => renderMessage(req.body, sampleData(req.body.event), 'https://testbench.example/…'),
  );

  // ---------- channels ----------
  r.get('/v1/channels', async (req): Promise<ChannelConfig[]> => {
    const stored = await deps.store.channels(tenantOf(req));
    return CHANNELS.map((channel) => {
      const c = stored.get(channel);
      // In-app and email work without setup; team channels need a destination.
      const needsTarget = (TEAM_CHANNELS as readonly string[]).includes(channel);
      return {
        channel,
        enabled: c?.enabled ?? !needsTarget,
        targetHint: maskTarget(channel, c?.target),
        configured: !needsTarget || !!c?.target,
      };
    });
  });
  r.put(
    '/v1/channels/:channel',
    { schema: { params: z.object({ channel: z.enum(CHANNELS) }), body: ChannelBody } },
    async (req, reply) => {
      const { channel } = req.params;
      const target = req.body.target;
      if (target) {
        const problem =
          channel === 'sms'
            ? parsePhoneNumbers(target)
              ? null
              : 'Use numbers in international format, e.g. +919876543210, separated by commas'
            : channel === 'email'
              ? /^[^@\s]+@[^@\s]+$/.test(target)
                ? null
                : 'Enter the From address, e.g. testbench@paytrail.in'
              : channel === 'inapp'
                ? null
                : checkWebhookTarget(channel as Exclude<TeamChannel, 'sms'>, target, opts.allowLocalTargets);
        if (problem) return reply.status(400).send({ error: { code: 'invalid_target', message: problem } });
      }
      await deps.store.saveChannel(tenantOf(req), channel, req.body);
      return reply.status(204).send();
    },
  );

  /** Sends the test message through one channel right away, so an admin can check the setup. */
  r.post(
    '/v1/channels/:channel/test',
    {
      schema: {
        params: z.object({ channel: z.enum(CHANNELS) }),
        body: z.object({
          recipient: z.object({ id: z.string(), name: z.string(), email: z.email().optional() }),
          sentBy: z.string().max(200),
        }),
      },
    },
    async (req, reply) => {
      const tenant = tenantOf(req);
      const { channel } = req.params;
      const recipient = (TEAM_CHANNELS as readonly string[]).includes(channel)
        ? `team:${channel}`
        : req.body.recipient.id;
      const message = {
        tenant,
        channel,
        recipient,
        email: req.body.recipient.email,
        event: 'test.message' as const,
        data: { sentBy: req.body.sentBy },
      };
      const deliverySk = await deps.store.logDelivery(tenant, {
        event: 'test.message',
        rule: 'Channel test',
        ruleVersion: 1,
        channel,
        recipient,
        status: 'queued',
        detail: null,
        message,
      });
      await deps.queues.send(channel, { ...message, deliverySk });
      return reply.status(202).send({ deliveryId: deliverySk });
    },
  );

  // ---------- deliveries ----------
  r.get(
    '/v1/deliveries',
    { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }) } },
    async (req) => deps.store.deliveries(tenantOf(req), req.query.limit),
  );
  r.post(
    '/v1/deliveries/resend',
    { schema: { body: z.object({ id: z.string().min(10).max(200) }) } },
    async (req, reply) =>
      (await resend(deps, tenantOf(req), req.body.id))
        ? reply.status(202).send({ ok: true })
        : reply.status(404).send({ error: { code: 'not_found', message: 'Delivery was not found' } }),
  );

  // ---------- inbox and preferences (per recipient) ----------
  const Who = z.object({ recipient: z.string().min(1).max(100) });
  r.get('/v1/inbox/:recipient', { schema: { params: Who } }, async (req) =>
    deps.store.inbox(tenantOf(req), req.params.recipient),
  );
  r.post(
    '/v1/inbox/:recipient/read',
    { schema: { params: Who, body: z.object({ ids: z.array(z.string().max(200)).max(200) }) } },
    async (req, reply) => {
      await deps.store.markRead(tenantOf(req), req.params.recipient, req.body.ids);
      return reply.status(204).send();
    },
  );
  r.get(
    '/v1/preferences/:recipient',
    { schema: { params: Who } },
    async (req) =>
      (await deps.store.preferences(tenantOf(req))).get(req.params.recipient) ?? {
        muted: {},
        quietHours: null,
      },
  );
  r.put(
    '/v1/preferences/:recipient',
    { schema: { params: Who, body: PreferencesBody } },
    async (req, reply) => {
      await deps.store.savePreferences(tenantOf(req), req.params.recipient, req.body);
      return reply.status(204).send();
    },
  );
};

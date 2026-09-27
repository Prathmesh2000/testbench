import {
  CHANNEL_LABELS,
  NOTIFY_EVENTS,
  type Channel,
  type NotifyEvent,
  type NotifyRequest,
  type Template,
  type TeamChannel,
} from '@tb/contracts';
import { defaultTemplate } from './defaults';
import { planDeliveries } from './plan';
import type { DeliveryMessage, FallbackMessage, Queues, Received } from './queues';
import { render } from './render';
import { parsePhoneNumbers, SendError, type Senders } from './senders';
import type { Store } from './store';

export interface Deps {
  store: Store;
  queues: Queues;
  senders: Senders;
  log: { error(o: object, m: string): void; info(o: object, m: string): void };
}

/** After this many attempts a delivery is marked failed and left in the dead-letter queue. */
const MAX_ATTEMPTS = 5;

/**
 * Ingest (HLD §5.7): dedupe on the idempotency key, plan deliveries from the tenant's rules and
 * preferences, log every one (suppressed ones too, with the reason) and queue the rest per channel.
 * Returns quickly; the sending happens in the channel workers.
 */
export async function ingest(
  deps: Deps,
  tenant: string,
  req: NotifyRequest,
): Promise<{ queued: number; suppressed: number; duplicate: boolean }> {
  if (!(await deps.store.claimIdempotency(tenant, req.idempotencyKey)))
    return { queued: 0, suppressed: 0, duplicate: true };
  const [rules, prefs] = await Promise.all([deps.store.rules(tenant), deps.store.preferences(tenant)]);
  const plan = planDeliveries(req, rules, (id) => prefs.get(id), new Date());
  let queued = 0;
  for (const d of plan) {
    const message: Omit<DeliveryMessage, 'deliverySk'> = {
      tenant,
      channel: d.channel,
      recipient: d.recipient,
      email: d.email,
      event: req.event,
      data: req.data,
      link: req.link,
      fallbackMinutes: d.fallbackMinutes,
    };
    const deliverySk = await deps.store.logDelivery(tenant, {
      event: req.event,
      rule: d.rule.name,
      ruleVersion: d.rule.version,
      channel: d.channel,
      recipient: d.recipient,
      status: d.suppressed ? 'suppressed' : 'queued',
      detail: d.suppressed ?? null,
      message,
    });
    if (d.suppressed) continue;
    await deps.queues.send(d.channel, { ...message, deliverySk });
    queued++;
  }
  return { queued, suppressed: plan.length - queued, duplicate: false };
}

/** A tenant's template for an event and channel: their override, else the built-in default. */
export async function templateFor(
  store: Store,
  tenant: string,
  event: NotifyEvent,
  channel: Channel,
): Promise<Template> {
  const override = (await store.templateOverrides(tenant)).get(`${event}#${channel}`);
  const t = override ?? defaultTemplate(event, channel);
  return { event, channel, subject: t.subject, body: t.body, customised: !!override };
}

/** Renders a template with event data (or the event's sample data, for previews in the console). */
export function renderMessage(
  t: Pick<Template, 'subject' | 'body'>,
  data: Record<string, unknown>,
  link?: string,
) {
  return { title: render(t.subject, data), body: render(t.body, data), link };
}

/** Sends one queued delivery. Throws SendError to retry; the caller decides between retry and failure. */
async function send(deps: Deps, m: DeliveryMessage): Promise<string> {
  const template = await templateFor(deps.store, m.tenant, m.event, m.channel);
  const msg = renderMessage(template, m.data, m.link);
  if (m.channel === 'inapp') {
    const inboxSk = await deps.store.addToInbox(m.tenant, m.recipient, {
      event: m.event,
      title: msg.title,
      body: msg.body,
      link: m.link ?? null,
    });
    if (m.fallbackMinutes && m.email)
      await deps.queues.send('fallback', { ...m, inboxSk }, m.fallbackMinutes * 60);
    return 'Added to inbox';
  }
  if (m.channel === 'email') {
    const html = `<p><strong>${render(template.subject, m.data, 'html')}</strong></p><p>${render(template.body, m.data, 'html')}</p>${m.link ? `<p><a href="${encodeURI(m.link)}">Open in Testbench</a></p>` : ''}`;
    const cfg = (await deps.store.channels(m.tenant)).get('email');
    await deps.senders.email(
      m.email!,
      cfg?.target,
      msg.title,
      m.link ? `${msg.body}\n\n${m.link}` : msg.body,
      html,
    );
    return `Sent to ${m.email}`;
  }
  const cfg = (await deps.store.channels(m.tenant)).get(m.channel);
  if (!cfg?.enabled || !cfg.target)
    throw new SendError(`${CHANNEL_LABELS[m.channel]} is not set up for this workspace`, true);
  if (m.channel === 'sms') {
    const numbers = parsePhoneNumbers(cfg.target);
    if (!numbers) throw new SendError('The SMS numbers are not valid', true);
    await deps.senders.text(numbers, msg);
    return `Sent to ${numbers.length} number${numbers.length === 1 ? '' : 's'}`;
  }
  const slackEscaped =
    m.channel === 'slack'
      ? {
          title: render(template.subject, m.data, 'slack'),
          body: render(template.body, m.data, 'slack'),
          link: m.link,
        }
      : msg;
  await deps.senders.webhook(m.channel as Exclude<TeamChannel, 'sms'>, cfg.target, slackEscaped);
  return 'Delivered to webhook';
}

/**
 * Handles one message from a channel queue: send it, record the outcome, and either delete it
 * (done or permanently failed) or leave it for a backed-off retry.
 */
export async function handleDelivery(
  deps: Deps,
  queue: Channel,
  got: Received<DeliveryMessage>,
): Promise<void> {
  const m = got.body;
  const started = Date.now();
  try {
    const detail = await send(deps, m);
    await deps.store.updateDelivery(
      m.tenant,
      m.deliverySk,
      'delivered',
      detail,
      Date.now() - started,
      got.receiveCount,
    );
    await deps.queues.done(queue, got.receipt);
  } catch (err) {
    const permanent = err instanceof SendError && err.permanent;
    const message = err instanceof Error ? err.message : String(err);
    if (permanent || got.receiveCount >= MAX_ATTEMPTS) {
      await deps.store.updateDelivery(
        m.tenant,
        m.deliverySk,
        'failed',
        message,
        Date.now() - started,
        got.receiveCount,
      );
      // Permanent failures leave the queue now; exhausted retries go to the dead-letter queue (queue config).
      if (permanent) await deps.queues.done(queue, got.receipt);
    } else {
      await deps.store.updateDelivery(
        m.tenant,
        m.deliverySk,
        'retrying',
        message,
        Date.now() - started,
        got.receiveCount,
      );
      await deps.queues.retryLater(queue, got.receipt, got.receiveCount);
    }
    if (!(err instanceof SendError)) deps.log.error({ err, channel: queue }, 'delivery failed unexpectedly');
  }
}

/** Fallback check: if the in-app item is still unread, email the person instead. */
export async function handleFallback(deps: Deps, got: Received<FallbackMessage>): Promise<void> {
  const m = got.body;
  if (!(await deps.store.isRead(m.tenant, m.recipient, m.inboxSk))) {
    const message = {
      tenant: m.tenant,
      channel: 'email' as const,
      recipient: m.recipient,
      email: m.email,
      event: m.event,
      data: m.data,
      link: m.link,
    };
    const deliverySk = await deps.store.logDelivery(m.tenant, {
      event: m.event,
      rule: 'Unread fallback',
      ruleVersion: 1,
      channel: 'email',
      recipient: m.recipient,
      status: 'queued',
      detail: `In-app notification unread after ${m.fallbackMinutes} min`,
      message,
    });
    await deps.queues.send('email', { ...message, deliverySk });
  }
  await deps.queues.done('fallback', got.receipt);
}

/** Re-queues a logged delivery exactly as it was first sent (console "Resend"). */
export async function resend(deps: Deps, tenant: string, deliverySk: string): Promise<boolean> {
  const d = await deps.store.delivery(tenant, deliverySk);
  if (!d?.message) return false;
  const message = d.message as Omit<DeliveryMessage, 'deliverySk'>;
  const sk = await deps.store.logDelivery(tenant, {
    event: d.event,
    rule: d.rule,
    ruleVersion: d.ruleVersion,
    channel: d.channel,
    recipient: d.recipient,
    status: 'queued',
    detail: 'Resent from the console',
    message,
  });
  await deps.queues.send(d.channel, { ...message, deliverySk: sk });
  return true;
}

/** Sample data for previews and test messages. */
export const sampleData = (event: NotifyEvent) =>
  NOTIFY_EVENTS[event].sample as Record<string, string | number>;

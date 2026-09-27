import { z } from 'zod';

// The notification service's API (HLD §1 #12, §5.7). It is its own product with its own store, so it
// knows nothing about Testbench beyond what a request carries: recipients, event data and a link.

/** Channels that reach a person. */
export const USER_CHANNELS = ['inapp', 'email'] as const;
/** Channels that reach a team destination configured once per tenant (a Slack channel, an on-call number). */
export const TEAM_CHANNELS = ['slack', 'teams', 'discord', 'sms'] as const;
export const CHANNELS = [...USER_CHANNELS, ...TEAM_CHANNELS] as const;
export type UserChannel = (typeof USER_CHANNELS)[number];
export type TeamChannel = (typeof TEAM_CHANNELS)[number];
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  inapp: 'In-app',
  email: 'Email',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  discord: 'Discord',
  sms: 'SMS',
};

/** What can trigger a notification, with the data each event carries (used for templates and previews). */
export const NOTIFY_EVENTS = {
  'run.assigned': {
    label: 'Run items assigned to you',
    sample: { runKey: 'RUN-231', runName: 'Release 4.18 smoke — Payments web', count: 42, build: '8812' },
  },
  'defect.logged': {
    label: 'Bug logged from a run',
    sample: {
      jiraKey: 'PAY-4952',
      summary: 'Collect request expiry ignored on Safari 17',
      severity: 'Blocker',
      reporter: 'Sneha Iyer',
    },
  },
  'defect.fixed': {
    label: 'Bug fixed in Jira, retest needed',
    sample: {
      jiraKey: 'PAY-4938',
      summary: 'OTP resend stays disabled after 30 seconds',
      cases: 'TC-10457, TC-10458',
    },
  },
  'filter.matched': {
    label: 'New case matches a saved filter',
    sample: {
      filterName: 'P0 failing in Checkout',
      caseKey: 'TC-110004',
      caseTitle: 'Verify wallet top-up limit',
    },
  },
  'requirement.changed': {
    label: 'PRD change flags your cases for review',
    sample: { documentTitle: 'UPI Autopay mandates', version: 3, count: 14 },
  },
  'test.message': { label: 'Test message', sample: { sentBy: 'Anita Desai' } },
} as const;
export type NotifyEvent = keyof typeof NOTIFY_EVENTS;
export const NOTIFY_EVENT_TYPES = Object.keys(NOTIFY_EVENTS) as NotifyEvent[];

const eventType = z.enum(NOTIFY_EVENT_TYPES as [NotifyEvent, ...NotifyEvent[]]);

export const Recipient = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200),
  email: z.email().optional(),
});
export type Recipient = z.infer<typeof Recipient>;

export const NotifyRequest = z.object({
  event: eventType,
  /** Repeating a request with the same key within 24 hours is a no-op; callers pass their event id. */
  idempotencyKey: z.string().min(8).max(200),
  recipients: z.array(Recipient).max(500).default([]),
  data: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.boolean()])),
  link: z.url().optional(),
});
export type NotifyRequest = z.infer<typeof NotifyRequest>;

export const RuleBody = z.object({
  name: z.string().trim().min(1).max(120),
  event: eventType,
  /** e.g. `severity = Blocker` or `count > 10`; empty means always. */
  condition: z.string().trim().max(500).default(''),
  userChannels: z.array(z.enum(USER_CHANNELS)).max(2),
  teamChannels: z.array(z.enum(TEAM_CHANNELS)).max(4),
  /** Email a person whose in-app notification is still unread after this many minutes. */
  fallbackMinutes: z.number().int().min(1).max(15).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type RuleBody = z.infer<typeof RuleBody>;
export interface Rule extends RuleBody {
  id: string;
  version: number;
  updatedAt: string;
}

export const TemplateBody = z.object({
  subject: z.string().max(300).default(''),
  body: z.string().min(1).max(5000),
});
export interface Template {
  event: NotifyEvent;
  channel: Channel;
  subject: string;
  body: string;
  /** False while the built-in default is in use. */
  customised: boolean;
}

export const ChannelBody = z.object({
  enabled: z.boolean(),
  /** Webhook URL (Slack, Teams, Discord), comma-separated phone numbers (SMS), or the From address (email). */
  target: z.string().trim().max(1000).optional(),
});
export interface ChannelConfig {
  channel: Channel;
  enabled: boolean;
  /** Shown masked: webhook URLs are credentials. */
  targetHint: string | null;
  configured: boolean;
}

export const PreferencesBody = z.object({
  /** Channels this person has turned off, per event. */
  muted: z.record(z.string(), z.array(z.enum(USER_CHANNELS))).default({}),
  /** Email is held back (in-app still arrives) between these local times, e.g. 22:00–08:00 IST. */
  quietHours: z
    .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
    .nullable()
    .default(null),
});
export type Preferences = z.infer<typeof PreferencesBody>;

export type DeliveryStatus = 'queued' | 'delivered' | 'retrying' | 'failed' | 'suppressed';
export interface Delivery {
  id: string;
  at: string;
  event: NotifyEvent;
  rule: string;
  ruleVersion: number;
  channel: Channel;
  recipient: string;
  status: DeliveryStatus;
  attempts: number;
  latencyMs: number | null;
  detail: string | null;
}

export interface InboxItem {
  id: string;
  at: string;
  event: NotifyEvent;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
}

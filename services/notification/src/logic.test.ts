import type { NotifyRequest, Preferences, Rule } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { ConditionError, matches, parseCondition } from './condition';
import { discordPayload, slackPayload, smsText, teamsPayload } from './payloads';
import { inQuietHours, planDeliveries } from './plan';
import { placeholders, render } from './render';

describe('render', () => {
  it('fills placeholders and blanks unknown ones', () => {
    expect(render('{{jiraKey}} fixed: {{summary}}{{nope}}', { jiraKey: 'PAY-1', summary: 'OTP' })).toBe(
      'PAY-1 fixed: OTP',
    );
  });

  it('escapes values for the destination but not the template', () => {
    expect(render('<b>{{x}}</b>', { x: '<script>&' }, 'html')).toBe('<b>&lt;script&gt;&amp;</b>');
    expect(render('*{{x}}*', { x: '<!channel>' }, 'slack')).toBe('*&lt;!channel&gt;*');
  });

  it('lists placeholders once', () => {
    expect(placeholders('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']);
  });
});

describe('conditions', () => {
  it('matches equality, lists and numbers, case-insensitively', () => {
    expect(matches('severity = blocker', { severity: 'Blocker' })).toBe(true);
    expect(matches('severity IN (Blocker, Critical)', { severity: 'Critical' })).toBe(true);
    expect(matches('count > 10 AND severity != Minor', { count: 11, severity: 'Major' })).toBe(true);
    expect(matches('count > 10', { count: 10 })).toBe(false);
  });

  it('treats an empty condition as always true and a missing field as not matching', () => {
    expect(matches('', {})).toBe(true);
    expect(matches('severity = Blocker', {})).toBe(false);
  });

  it('explains conditions it cannot read', () => {
    expect(() => parseCondition('severity is bad')).toThrow(ConditionError);
  });
});

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  name: 'Run assignments',
  event: 'run.assigned',
  condition: '',
  userChannels: ['inapp', 'email'],
  teamChannels: [],
  fallbackMinutes: null,
  enabled: true,
  version: 1,
  updatedAt: '',
  ...over,
});
const request: NotifyRequest = {
  event: 'run.assigned',
  idempotencyKey: 'event-123456',
  data: { count: 3 },
  recipients: [
    { id: 'u1', name: 'Sneha', email: 'sneha@x.in' },
    { id: 'u2', name: 'No Mail' },
  ],
};
const noon = new Date('2026-09-27T06:30:00Z'); // 12:00 IST
const night = new Date('2026-09-27T17:30:00Z'); // 23:00 IST

describe('planDeliveries', () => {
  it('fans user channels out per person and team channels once', () => {
    const plan = planDeliveries(request, [rule({ teamChannels: ['slack'] })], () => undefined, noon);
    expect(plan.map((d) => `${d.channel}:${d.recipient}:${d.suppressed ?? 'send'}`)).toEqual([
      'inapp:u1:send',
      'email:u1:send',
      'inapp:u2:send',
      'email:u2:No email address',
      'slack:team:slack:send',
    ]);
  });

  it('skips disabled rules, other events and failing conditions', () => {
    expect(planDeliveries(request, [rule({ enabled: false })], () => undefined, noon)).toEqual([]);
    expect(planDeliveries(request, [rule({ event: 'defect.fixed' })], () => undefined, noon)).toEqual([]);
    expect(planDeliveries(request, [rule({ condition: 'count > 5' })], () => undefined, noon)).toEqual([]);
  });

  it('honours muted channels and holds email back in quiet hours', () => {
    const prefs: Preferences = {
      muted: { 'run.assigned': ['inapp'] },
      quietHours: { start: '22:00', end: '08:00' },
    };
    const plan = planDeliveries(
      { ...request, recipients: [request.recipients[0]!] },
      [rule()],
      () => prefs,
      night,
    );
    expect(plan.map((d) => `${d.channel}:${d.suppressed ?? 'send'}`)).toEqual([
      'inapp:Turned off in their preferences',
      'email:Quiet hours',
    ]);
  });

  it('adds an email fallback only when in-app is the sole user channel and the person has an address', () => {
    const plan = planDeliveries(
      request,
      [rule({ userChannels: ['inapp'], fallbackMinutes: 10 })],
      () => undefined,
      noon,
    );
    expect(plan.find((d) => d.recipient === 'u1')!.fallbackMinutes).toBe(10);
    expect(plan.find((d) => d.recipient === 'u2')!.fallbackMinutes).toBeUndefined();
  });
});

describe('inQuietHours', () => {
  it('handles windows that cross midnight', () => {
    const q = { start: '22:00', end: '08:00' };
    expect(inQuietHours(q, night)).toBe(true);
    expect(inQuietHours(q, noon)).toBe(false);
    expect(inQuietHours({ start: '09:00', end: '17:00' }, noon)).toBe(true);
    expect(inQuietHours(null, night)).toBe(false);
  });
});

describe('payloads', () => {
  const m = { title: 'PAY-4938 fixed', body: 'Retest TC-10457', link: 'http://localhost:3000/defects' };

  it('builds provider-specific webhook bodies', () => {
    expect(slackPayload(m).blocks[1]).toMatchObject({ type: 'actions' });
    expect(teamsPayload(m).attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(discordPayload(m).embeds[0]).toMatchObject({ title: 'PAY-4938 fixed', url: m.link });
  });

  it('keeps SMS to one 160-character segment, link intact', () => {
    const long = smsText({ ...m, title: 'x'.repeat(300) });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith(m.link)).toBe(true);
    expect(smsText(m)).toBe(`PAY-4938 fixed ${m.link}`);
  });
});

describe('webhook and phone targets', () => {
  it('accepts only real provider hosts over https', async () => {
    const { checkWebhookTarget } = await import('./senders');
    expect(checkWebhookTarget('slack', 'https://hooks.slack.com/services/T0/B0/xyz', false)).toBeNull();
    expect(checkWebhookTarget('discord', 'https://discord.com/api/webhooks/1/abc', false)).toBeNull();
    expect(
      checkWebhookTarget('teams', 'https://prod-11.westus.logic.azure.com/workflows/abc', false),
    ).toBeNull();
    expect(checkWebhookTarget('slack', 'http://hooks.slack.com/x', false)).toContain('https');
    expect(checkWebhookTarget('slack', 'https://169.254.169.254/latest/meta-data', false)).toContain(
      'does not look like',
    );
    expect(checkWebhookTarget('slack', 'https://hooks.slack.com.evil.io/x', false)).toContain(
      'does not look like',
    );
  });

  it('allows local sandboxes only when the deployment says so', async () => {
    const { checkWebhookTarget } = await import('./senders');
    expect(checkWebhookTarget('slack', 'http://localhost:8091/slack/qa', true)).toBeNull();
    expect(checkWebhookTarget('slack', 'http://localhost:8091/slack/qa', false)).toBe(
      'Local addresses are not allowed',
    );
  });

  it('accepts E.164 phone numbers only', async () => {
    const { parsePhoneNumbers } = await import('./senders');
    expect(parsePhoneNumbers('+919876543210, +14155550123')).toEqual(['+919876543210', '+14155550123']);
    expect(parsePhoneNumbers('9876543210')).toBeNull();
  });
});

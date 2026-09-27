import type { Channel, NotifyRequest, Preferences, Rule, TeamChannel, UserChannel } from '@tb/contracts';
import { matches } from './condition';

export interface PlannedDelivery {
  rule: Rule;
  channel: Channel;
  /** A person's id for user channels; the team destination for team channels. */
  recipient: string;
  email?: string;
  /** Delivered to the log only, with the reason (opted out, quiet hours, no email address). */
  suppressed?: string;
  /** For in-app deliveries with a fallback: check read state after this many minutes, then email. */
  fallbackMinutes?: number;
}

/** Minutes since midnight in IST, the timezone quiet hours are written in. */
function istMinutes(now: Date): number {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Quiet hours may cross midnight (22:00–08:00). */
export function inQuietHours(quiet: Preferences['quietHours'], now: Date): boolean {
  if (!quiet) return false;
  const t = istMinutes(now);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

/**
 * Turns one request into deliveries (HLD §5.7): every enabled rule for the event whose condition holds,
 * fanned out to its user channels per recipient and its team channels once each. A person's own
 * preferences apply after the rule: they can mute a channel, and quiet hours hold back email (the
 * in-app copy still arrives, so nothing is lost). Suppressed deliveries are still planned so the log
 * explains why nothing was sent.
 */
export function planDeliveries(
  request: NotifyRequest,
  rules: readonly Rule[],
  prefsFor: (recipientId: string) => Preferences | undefined,
  now: Date,
): PlannedDelivery[] {
  const out: PlannedDelivery[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.event !== request.event || !matches(rule.condition, request.data)) continue;

    for (const person of request.recipients) {
      const prefs = prefsFor(person.id);
      const muted = new Set<UserChannel>(prefs?.muted[request.event] ?? []);
      const quiet = inQuietHours(prefs?.quietHours ?? null, now);
      for (const channel of rule.userChannels) {
        const base = { rule, channel, recipient: person.id, email: person.email };
        if (muted.has(channel)) out.push({ ...base, suppressed: 'Turned off in their preferences' });
        else if (channel === 'email' && !person.email) out.push({ ...base, suppressed: 'No email address' });
        else if (channel === 'email' && quiet) out.push({ ...base, suppressed: 'Quiet hours' });
        else out.push(base);
      }
      // Fallback only makes sense when in-app is the only way the rule reaches this person.
      const inapp = out.find((d) => d.rule === rule && d.recipient === person.id && d.channel === 'inapp');
      if (
        rule.fallbackMinutes &&
        inapp &&
        !inapp.suppressed &&
        !rule.userChannels.includes('email') &&
        person.email &&
        !muted.has('email')
      ) {
        inapp.fallbackMinutes = rule.fallbackMinutes;
      }
    }
    for (const channel of rule.teamChannels as TeamChannel[])
      out.push({ rule, channel, recipient: `team:${channel}` });
  }
  return out;
}

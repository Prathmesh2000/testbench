import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import type { TeamChannel } from '@tb/contracts';
import nodemailer, { type Transporter } from 'nodemailer';
import { discordPayload, slackPayload, smsText, teamsPayload, type Message } from './payloads';

/** Where each team channel's webhooks may point. Anything else is refused before a request is made. */
const WEBHOOK_HOSTS: Record<Exclude<TeamChannel, 'sms'>, RegExp> = {
  slack: /^hooks\.slack\.com$/,
  // Teams Workflows webhooks live on Power Automate / Logic Apps hosts.
  teams: /(^|\.)(logic\.azure\.com|powerautomate\.com|powerplatform\.com)$/,
  discord: /^(discord\.com|discordapp\.com)$/,
};

/**
 * Checks a webhook URL an admin entered. Without this, the service would send requests to any address
 * a tenant admin typed, including internal ones (SSRF). Local sandboxes are allowed only when the
 * deployment says so (local development).
 */
export function checkWebhookTarget(
  channel: Exclude<TeamChannel, 'sms'>,
  url: string,
  allowLocal: boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter the full webhook URL, starting with https://';
  }
  const local = ['localhost', '127.0.0.1', 'host.docker.internal'].includes(parsed.hostname);
  if (local) return allowLocal ? null : 'Local addresses are not allowed';
  if (parsed.protocol !== 'https:') return 'Webhook URLs must use https://';
  if (!WEBHOOK_HOSTS[channel].test(parsed.hostname))
    return `That does not look like a ${channel} webhook URL`;
  return null;
}

/** E.164 numbers only (+91…), comma-separated. */
export function parsePhoneNumbers(target: string): string[] | null {
  const numbers = target
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return numbers.length && numbers.every((n) => /^\+[1-9]\d{7,14}$/.test(n)) ? numbers : null;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
  }
}

export interface SenderConfig {
  smtpUrl: string;
  emailFrom: string;
  /** Local provider sandbox for SMS; when unset, SMS goes through AWS End User Messaging. */
  smsSandboxUrl?: string;
  smsOriginationIdentity?: string;
  region: string;
}

export class Senders {
  private readonly mail: Transporter;
  private readonly sms?: PinpointSMSVoiceV2Client;

  constructor(private readonly cfg: SenderConfig) {
    this.mail = nodemailer.createTransport(cfg.smtpUrl);
    if (!cfg.smsSandboxUrl) this.sms = new PinpointSMSVoiceV2Client({ region: cfg.region });
  }

  async email(
    to: string,
    from: string | undefined,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    await this.mail
      .sendMail({ from: from || this.cfg.emailFrom, to, subject, text, html })
      .catch((err: Error) => {
        throw new SendError(`Mail server refused the message: ${err.message}`);
      });
  }

  async webhook(channel: Exclude<TeamChannel, 'sms'>, url: string, m: Message): Promise<void> {
    const payload =
      channel === 'slack' ? slackPayload(m) : channel === 'teams' ? teamsPayload(m) : discordPayload(m);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: Error) => {
      throw new SendError(`Could not reach ${channel}: ${err.message}`);
    });
    // 4xx other than rate limiting means the webhook is wrong or revoked: retrying cannot help.
    if (!res.ok)
      throw new SendError(
        `${channel} answered HTTP ${res.status}`,
        res.status >= 400 && res.status < 500 && res.status !== 429,
      );
  }

  async text(numbers: string[], m: Message): Promise<void> {
    const message = smsText(m);
    for (const to of numbers) {
      if (this.cfg.smsSandboxUrl) {
        const res = await fetch(this.cfg.smsSandboxUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to, message }),
        });
        if (!res.ok) throw new SendError(`SMS sandbox answered HTTP ${res.status}`);
      } else {
        await this.sms!.send(
          new SendTextMessageCommand({
            DestinationPhoneNumber: to,
            MessageBody: message,
            MessageType: 'TRANSACTIONAL',
            OriginationIdentity: this.cfg.smsOriginationIdentity,
          }),
        ).catch((err: Error) => {
          throw new SendError(`SMS provider refused the message: ${err.message}`);
        });
      }
    }
  }
}

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Channel, NotifyEvent } from '@tb/contracts';

/** One queued delivery. Rendering happens in the worker, so a template fix applies to retries too. */
export interface DeliveryMessage {
  tenant: string;
  deliverySk: string;
  channel: Channel;
  recipient: string;
  email?: string;
  event: NotifyEvent;
  data: Record<string, string | number | boolean>;
  link?: string;
  /** Set on in-app deliveries that should fall back to email when unread. */
  fallbackMinutes?: number;
}

/** Sent to the fallback queue with a delay: "email this person if the in-app item is still unread". */
export interface FallbackMessage extends DeliveryMessage {
  inboxSk: string;
}

export type QueueName = Channel | 'fallback';
export const QUEUE_NAMES: QueueName[] = ['email', 'sms', 'slack', 'teams', 'discord', 'inapp', 'fallback'];

export interface Received<T> {
  body: T;
  receipt: string;
  /** How many times this message has been handed out, including this one. */
  receiveCount: number;
}

/** SQS queues, one per channel (HLD §5.7). Locally ElasticMQ; in AWS the queue URLs are resolved the same way. */
export class Queues {
  private readonly urls = new Map<QueueName, string>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly prefix: string,
  ) {}

  static create(cfg: { endpoint?: string; region: string; prefix: string }): Queues {
    return new Queues(
      new SQSClient({
        region: cfg.region,
        ...(cfg.endpoint && {
          endpoint: cfg.endpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }),
      }),
      cfg.prefix,
    );
  }

  private async url(name: QueueName): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = (await this.sqs.send(new GetQueueUrlCommand({ QueueName: `${this.prefix}-${name}` }))).QueueUrl!;
      this.urls.set(name, url);
    }
    return url;
  }

  /** SQS allows at most 15 minutes of delay, which is why fallbacks are capped at 15 minutes. */
  async send(name: QueueName, body: DeliveryMessage | FallbackMessage, delaySeconds = 0): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.url(name),
        MessageBody: JSON.stringify(body),
        DelaySeconds: Math.min(delaySeconds, 900),
      }),
    );
  }

  async receive<T>(name: QueueName, max = 10, waitSeconds = 10): Promise<Received<T>[]> {
    const res = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.url(name),
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    return (res.Messages ?? []).map((m) => ({
      body: JSON.parse(m.Body!) as T,
      receipt: m.ReceiptHandle!,
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
    }));
  }

  async done(name: QueueName, receipt: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: await this.url(name), ReceiptHandle: receipt }));
  }

  /** Exponential backoff between attempts: 10s, 20s, 40s, 80s. */
  async retryLater(name: QueueName, receipt: string, attempt: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: receipt,
        VisibilityTimeout: Math.min(10 * 2 ** (attempt - 1), 900),
      }),
    );
  }
}

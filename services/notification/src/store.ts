import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient, ResourceInUseException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Channel,
  Delivery,
  DeliveryStatus,
  InboxItem,
  NotifyEvent,
  Preferences,
  Rule,
  RuleBody,
} from '@tb/contracts';
import { DEFAULT_RULES } from './defaults';

/**
 * The notification service's own store: one DynamoDB table (HLD §1 #12), partitioned per tenant and
 * record type. Nothing here is shared with Testbench's Postgres; the service can run and scale alone.
 *
 *   pk T#<tenant>#RULE      sk <rule id>
 *   pk T#<tenant>#TPL       sk <event>#<channel>
 *   pk T#<tenant>#CH        sk <channel>
 *   pk T#<tenant>#PREF      sk <recipient>
 *   pk T#<tenant>#DEL       sk <iso time>#<id>     (30-day TTL)
 *   pk T#<tenant>#IN#<who>  sk <iso time>#<id>     (90-day TTL)
 *   pk T#<tenant>#IDEM      sk <idempotency key>   (24-hour TTL)
 */
export class Store {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  static create(cfg: { endpoint?: string; region: string; table: string }): Store {
    return new Store(
      new DynamoDBClient({
        region: cfg.region,
        ...(cfg.endpoint && {
          endpoint: cfg.endpoint,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        }),
      }),
      cfg.table,
    );
  }

  /** Creates the table locally. In AWS it comes from Terraform, with TTL enabled on `ttl`. */
  async ensureTable(): Promise<void> {
    try {
      await this.client.send(
        new CreateTableCommand({
          TableName: this.table,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
        }),
      );
    } catch (err) {
      if (!(err instanceof ResourceInUseException)) throw err;
    }
  }

  private async query<T>(pk: string, opts: { limit?: number; newestFirst?: boolean } = {}): Promise<T[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: !opts.newestFirst,
        Limit: opts.limit,
      }),
    );
    return (res.Items ?? []) as T[];
  }

  /**
   * Records an idempotency key; false when it was already seen, so a retried request does nothing.
   * The conditional put makes this atomic even with several API instances.
   */
  async claimIdempotency(tenant: string, key: string): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `T#${tenant}#IDEM`, sk: key, ttl: Math.floor(Date.now() / 1000) + 86_400 },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  // ---------- rules ----------
  /** A tenant's rules, seeding the defaults the first time the tenant is seen. */
  async rules(tenant: string): Promise<Rule[]> {
    const rows = await this.query<Rule & { pk: string; sk: string }>(`T#${tenant}#RULE`);
    if (rows.length) return rows.map(({ pk: _pk, sk: _sk, ...r }) => r as Rule);
    const seeded = DEFAULT_RULES.map((r) => ({
      ...r,
      id: randomUUID(),
      version: 1,
      updatedAt: new Date().toISOString(),
    }));
    for (const r of seeded)
      await this.doc.send(
        new PutCommand({ TableName: this.table, Item: { pk: `T#${tenant}#RULE`, sk: r.id, ...r } }),
      );
    return seeded;
  }

  /** Saves a rule as a new version, so the delivery log can say which version sent each message. */
  async saveRule(tenant: string, id: string | null, body: RuleBody): Promise<Rule> {
    const current = id
      ? ((
          await this.doc.send(
            new GetCommand({ TableName: this.table, Key: { pk: `T#${tenant}#RULE`, sk: id } }),
          )
        ).Item as Rule | undefined)
      : undefined;
    const rule: Rule = {
      ...body,
      id: id ?? randomUUID(),
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk: `T#${tenant}#RULE`, sk: rule.id, ...rule } }),
    );
    return rule;
  }

  async deleteRule(tenant: string, id: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { pk: `T#${tenant}#RULE`, sk: id } }),
    );
  }

  // ---------- templates ----------
  async templateOverrides(tenant: string): Promise<Map<string, { subject: string; body: string }>> {
    const rows = await this.query<{ sk: string; subject: string; body: string }>(`T#${tenant}#TPL`);
    return new Map(rows.map((r) => [r.sk, { subject: r.subject, body: r.body }]));
  }

  async saveTemplate(
    tenant: string,
    event: NotifyEvent,
    channel: Channel,
    t: { subject: string; body: string } | null,
  ): Promise<void> {
    const Key = { pk: `T#${tenant}#TPL`, sk: `${event}#${channel}` };
    if (t) await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...Key, ...t } }));
    else await this.doc.send(new DeleteCommand({ TableName: this.table, Key }));
  }

  // ---------- channels ----------
  async channels(tenant: string): Promise<Map<Channel, { enabled: boolean; target?: string }>> {
    const rows = await this.query<{ sk: Channel; enabled: boolean; target?: string }>(`T#${tenant}#CH`);
    return new Map(rows.map((r) => [r.sk, { enabled: r.enabled, target: r.target }]));
  }

  async saveChannel(
    tenant: string,
    channel: Channel,
    cfg: { enabled: boolean; target?: string },
  ): Promise<void> {
    const existing = (await this.channels(tenant)).get(channel);
    // An omitted target keeps the stored one: the console never sees the secret URL, so it cannot resend it.
    const target = cfg.target === undefined ? existing?.target : cfg.target || undefined;
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `T#${tenant}#CH`, sk: channel, enabled: cfg.enabled, target },
      }),
    );
  }

  // ---------- preferences ----------
  async preferences(tenant: string): Promise<Map<string, Preferences>> {
    const rows = await this.query<{ sk: string; prefs: Preferences }>(`T#${tenant}#PREF`);
    return new Map(rows.map((r) => [r.sk, r.prefs]));
  }

  async savePreferences(tenant: string, recipient: string, prefs: Preferences): Promise<void> {
    await this.doc.send(
      new PutCommand({ TableName: this.table, Item: { pk: `T#${tenant}#PREF`, sk: recipient, prefs } }),
    );
  }

  // ---------- delivery log ----------
  /** Adds a delivery to the log; the returned sort key identifies it for later status updates. */
  async logDelivery(
    tenant: string,
    d: Omit<Delivery, 'id' | 'at' | 'attempts' | 'latencyMs'> & { message?: unknown },
  ): Promise<string> {
    const at = new Date().toISOString();
    const sk = `${at}#${randomUUID()}`;
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: `T#${tenant}#DEL`,
          sk,
          at,
          attempts: 0,
          latencyMs: null,
          ...d,
          ttl: Math.floor(Date.now() / 1000) + 30 * 86_400,
        },
      }),
    );
    return sk;
  }

  async updateDelivery(
    tenant: string,
    sk: string,
    status: DeliveryStatus,
    detail: string | null,
    latencyMs: number | null,
    attempts: number,
  ): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `T#${tenant}#DEL`, sk },
        UpdateExpression: 'SET #s = :s, detail = :d, latencyMs = :l, attempts = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status, ':d': detail, ':l': latencyMs, ':a': attempts },
      }),
    );
  }

  async delivery(tenant: string, sk: string): Promise<(Delivery & { message?: unknown }) | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `T#${tenant}#DEL`, sk } }),
    );
    return res.Item ? toDelivery(res.Item) : undefined;
  }

  async deliveries(tenant: string, limit = 200): Promise<Delivery[]> {
    return (await this.query<Record<string, unknown>>(`T#${tenant}#DEL`, { limit, newestFirst: true })).map(
      toDelivery,
    );
  }

  // ---------- in-app inbox ----------
  async addToInbox(
    tenant: string,
    recipient: string,
    item: Omit<InboxItem, 'id' | 'at' | 'read'>,
  ): Promise<string> {
    const at = new Date().toISOString();
    const sk = `${at}#${randomUUID()}`;
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: `T#${tenant}#IN#${recipient}`,
          sk,
          at,
          read: false,
          ...item,
          ttl: Math.floor(Date.now() / 1000) + 90 * 86_400,
        },
      }),
    );
    return sk;
  }

  async inbox(tenant: string, recipient: string, limit = 50): Promise<InboxItem[]> {
    const rows = await this.query<Record<string, unknown>>(`T#${tenant}#IN#${recipient}`, {
      limit,
      newestFirst: true,
    });
    return rows.map((r) => ({
      id: r.sk as string,
      at: r.at as string,
      event: r.event as NotifyEvent,
      title: r.title as string,
      body: r.body as string,
      link: (r.link as string) ?? null,
      read: !!r.read,
    }));
  }

  async isRead(tenant: string, recipient: string, sk: string): Promise<boolean> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `T#${tenant}#IN#${recipient}`, sk } }),
    );
    return !!res.Item?.read;
  }

  async markRead(tenant: string, recipient: string, ids: string[]): Promise<void> {
    for (const sk of ids) {
      await this.doc
        .send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: `T#${tenant}#IN#${recipient}`, sk },
            UpdateExpression: 'SET #r = :t',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: { '#r': 'read' },
            ExpressionAttributeValues: { ':t': true },
          }),
        )
        .catch((err: { name?: string }) => {
          if (err.name !== 'ConditionalCheckFailedException') throw err; // already expired: nothing to mark
        });
    }
  }
}

function toDelivery(r: Record<string, unknown>): Delivery & { message?: unknown } {
  return {
    id: r.sk as string,
    at: r.at as string,
    event: r.event as NotifyEvent,
    rule: r.rule as string,
    ruleVersion: (r.ruleVersion as number) ?? 1,
    channel: r.channel as Channel,
    recipient: r.recipient as string,
    status: r.status as DeliveryStatus,
    attempts: (r.attempts as number) ?? 0,
    latencyMs: (r.latencyMs as number | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    message: r.message,
  };
}

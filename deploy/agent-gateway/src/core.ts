import type { Me } from '@tb/contracts';

/** An error from core-api, with the message it wrote for people (safe to pass on to an agent or Slack). */
export class CoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * core-api as the calling user. The gateway holds no permissions of its own: every call carries the
 * user's own access token, so an agent or Slack command can never do more than that person could in
 * the web app (HLD §5.8). `client` only labels the audit log.
 */
export class CoreClient {
  private me: Promise<Me> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly client: 'mcp' | 'slack',
  ) {}

  async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-tb-client': this.client,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    if (!res.ok) throw new CoreError(res.status, data?.error?.message ?? `Testbench answered ${res.status}`);
    return data as T;
  }

  get<T>(path: string) {
    return this.call<T>('GET', path);
  }

  whoami(): Promise<Me> {
    this.me ??= this.get<Me>('/me');
    return this.me;
  }

  /** A project by its key ("PAY"), or the caller's only project when they have one. */
  async project(key?: string): Promise<{ id: string; key: string; name: string }> {
    const { projects } = await this.whoami();
    if (!key) {
      if (projects.length === 1) return projects[0]!;
      throw new CoreError(400, `Say which project: ${projects.map((p) => p.key).join(', ')}.`);
    }
    const p = projects.find((x) => x.key.toLowerCase() === key.toLowerCase());
    if (!p)
      throw new CoreError(
        404,
        `No project ${key} that you can see. Yours: ${projects.map((x) => x.key).join(', ')}.`,
      );
    return p;
  }
}

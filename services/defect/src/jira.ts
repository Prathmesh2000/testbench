import type { AdfDoc } from './bug-report';

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  webhookSecret: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: 'new' | 'indeterminate' | 'done' } };
    assignee?: { displayName: string } | null;
    fixVersions?: { name: string }[];
    issuetype?: { name: string };
    updated: string;
  };
}

export interface JiraStatusInfo {
  name: string;
  statusCategory: { key: 'new' | 'indeterminate' | 'done' };
}

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}

const FIELDS = ['summary', 'status', 'assignee', 'fixVersions', 'issuetype', 'updated'];
const MAX_CONCURRENT = 4;
const TIMEOUT_MS = 10_000;

/**
 * Jira Cloud REST v3 client (API-token auth; OAuth 3LO as the user comes with the admin console).
 * All calls to one site share a small concurrency limit and honour Retry-After on 429, so a burst of
 * bug logging cannot get the whole Jira site throttled (HLD §7.2).
 */
export class JiraClient {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly cfg: JiraConfig) {}

  browseUrl(key: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/browse/${key}`;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
    const res = await this.slot(() =>
      fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64')}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((err: Error) => {
        throw new JiraError(
          503,
          `Could not reach Jira: ${err.name === 'TimeoutError' ? 'it did not answer in time' : err.message}`,
        );
      }),
    );
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? '2'), 30) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.request(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        errorMessages?: string[];
        errors?: Record<string, string>;
      } | null;
      const detail = data?.errorMessages?.[0] ?? Object.values(data?.errors ?? {})[0] ?? res.statusText;
      throw new JiraError(res.status, `Jira refused the request: ${detail}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  createIssue(fields: {
    projectKey: string;
    summary: string;
    description: AdfDoc;
    priority: string;
    labels: string[];
  }) {
    return this.request<{ id: string; key: string }>('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: fields.projectKey },
        issuetype: { name: 'Bug' },
        summary: fields.summary,
        description: fields.description,
        priority: { name: fields.priority },
        labels: fields.labels,
      },
    });
  }

  getIssue(key: string) {
    return this.request<JiraIssue>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`,
    );
  }

  search(jql: string, maxResults = 50) {
    return this.request<{ issues: JiraIssue[] }>('POST', '/rest/api/3/search/jql', {
      jql,
      fields: FIELDS,
      maxResults,
    });
  }

  /** Every status of every issue type in a Jira project: the workflow as that team configured it. */
  projectStatuses(projectKey: string) {
    return this.request<{ name: string; statuses: JiraStatusInfo[] }[]>(
      'GET',
      `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`,
    );
  }

  comment(key: string, body: AdfDoc) {
    return this.request<unknown>('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body });
  }

  /** Moves an issue to the first status with the given name (Jira's transition ids differ per workflow). */
  async transitionTo(key: string, statusName: string): Promise<boolean> {
    const { transitions } = await this.request<{ transitions: { id: string; to: { name: string } }[] }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    const match = transitions.find((t) => t.to.name.toLowerCase() === statusName.toLowerCase());
    if (!match) return false;
    await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: match.id },
    });
    return true;
  }
}

/** JQL string literal: quotes and backslashes escaped, so summary text cannot change the query. */
export const jqlString = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

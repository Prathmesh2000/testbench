import type { AdfDoc } from './bug-report';

/** One person's Jira account: everything the client does shows as them in Jira. */
export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
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
 * Jira Cloud REST v3 client for one person's account (API-token auth; OAuth comes later). Calls through
 * one client share a small concurrency limit and honour Retry-After on 429, so a burst of bug logging
 * cannot get the account throttled (HLD §7.2).
 */
export class JiraClient {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly cfg: JiraConfig) {}

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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 1,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    const form = body instanceof FormData;
    const res = await this.slot(() =>
      fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64')}`,
          accept: 'application/json',
          ...(body !== undefined && !form && { 'content-type': 'application/json' }),
          // Jira refuses multipart uploads without this header (its XSRF guard for form posts).
          ...(form && { 'x-atlassian-token': 'no-check' }),
        },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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
      return this.request(method, path, body, attempt + 1, timeoutMs);
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

  /** The account behind the token; used to verify a connection and label it with the person's name. */
  myself() {
    return this.request<{ accountId: string; displayName: string; emailAddress?: string }>(
      'GET',
      '/rest/api/3/myself',
    );
  }

  /** Projects this account can see, for the project mapping picker. */
  async projects(): Promise<{ key: string; name: string }[]> {
    const page = await this.request<{ values: { key: string; name: string }[] }>(
      'GET',
      '/rest/api/3/project/search?maxResults=100&orderBy=name',
    );
    return page.values.map((p) => ({ key: p.key, name: p.name }));
  }

  /** Issue types this account may create in a project (throws 404 when the project isn't visible). */
  async issueTypes(projectKey: string): Promise<string[]> {
    const res = await this.request<{ issueTypes?: { name: string }[]; values?: { name: string }[] }>(
      'GET',
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
    );
    return (res.issueTypes ?? res.values ?? []).map((t) => t.name);
  }

  /** Whether the site accepts attachments and its per-file limit in bytes (set by the site admin). */
  attachmentSettings() {
    return this.request<{ enabled: boolean; uploadLimit: number }>('GET', '/rest/api/3/attachment/meta');
  }

  async attach(key: string, file: { name: string; contentType: string; bytes: Uint8Array }) {
    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.contentType }), file.name);
    const [created] = await this.request<{ id: string }[]>(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`,
      form,
      1,
      // Large screenshots and recordings need longer than an ordinary API call.
      120_000,
    );
    return created;
  }

  createIssue(fields: {
    projectKey: string;
    issueType: string;
    summary: string;
    description: AdfDoc;
    priority: string;
    labels: string[];
  }) {
    return this.request<{ id: string; key: string }>('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: fields.projectKey },
        issuetype: { name: fields.issueType },
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

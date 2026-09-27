import type { NotifyRequest } from '@tb/contracts';
import { AppError } from '@tb/platform';

/**
 * core-api's client for the notification service. Testbench organisations are the service's tenants.
 * Everything the web app does with notifications goes through core-api, which checks permissions and
 * then calls the service with the shared service key; the browser never talks to the service directly.
 */
export class NotifyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceKey: string,
  ) {}

  async request<T>(tenant: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.serviceKey}`,
        'x-tenant-id': tenant,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: Error) => {
      throw new AppError(
        503,
        'notifications_unavailable',
        `The notification service is not reachable (${err.message}).`,
      );
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string; details?: unknown };
    } | null;
    // Validation problems pass through so the console can show them; anything else is our failure.
    if (!res.ok) {
      if (res.status < 500 && data?.error)
        throw new AppError(res.status, data.error.code, data.error.message, data.error.details);
      throw new AppError(
        502,
        'notifications_failed',
        'The notification service could not complete the request.',
      );
    }
    return data as T;
  }

  notify(tenant: string, req: NotifyRequest) {
    return this.request<{ queued: number }>(tenant, 'POST', '/v1/notify', req);
  }
}

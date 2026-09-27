// Browser-side API client. Every call goes to the same-origin proxy (/api/core/*), which attaches the
// access token; see app/api/core/[...path]/route.ts.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/core${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    // The session is gone (refresh token expired or revoked): send the user back through sign-in.
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, 'unauthenticated', 'Signing you in again…');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);

/** Query string from an object, skipping empty values and joining arrays the way the API expects ("a,b"). */
export function qs(params: Record<string, string | number | string[] | undefined | null>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

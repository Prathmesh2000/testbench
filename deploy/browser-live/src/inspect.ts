import type { RequestDetail, RequestTiming, StorageSnapshot } from '@tb/contracts';
import { maskText, maskValue } from '@tb/platform';
import type { BrowserContext, Page, Request } from 'playwright';

// What the pane's Network and Application tabs show, read from the live browser on request. By
// default it is masked the way evidence is (platform/mask.ts): credential-like headers, cookies and
// storage keys hidden, bodies pattern-masked. `reveal` is the tester asking, in the pane, to see
// their own session unmasked; it only changes what is sent to them, nothing is stored.

/** Biggest body or payload sent to the pane; beyond it the tester is told, not sent megabytes. */
export const BODY_LIMIT = 200_000;
const STORAGE_VALUE_LIMIT = 10_000;
const STORAGE_ENTRIES = 500;

/** Content the pane can show as text. */
export function isTextual(contentType: string | null): boolean {
  if (!contentType) return false;
  return /^text\/|json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|svg|csv/i.test(contentType);
}

export function clip(text: string, limit = BODY_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… cut at ${Math.round(limit / 1000)} KB of ${Math.round(text.length / 1000)} KB` : text;
}

/** Playwright's timing marks (ms from the start, -1 when absent) as the phases DevTools shows. */
export function phases(t: {
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}): RequestTiming {
  const span = (a: number, b: number) => (a >= 0 && b >= a ? Math.round(b - a) : 0);
  return {
    dns: span(t.domainLookupStart, t.domainLookupEnd),
    connect: span(t.connectStart, t.secureConnectionStart >= 0 ? t.secureConnectionStart : t.connectEnd),
    tls: span(t.secureConnectionStart, t.connectEnd),
    wait: span(t.requestStart, t.responseStart),
    download: span(t.responseStart, t.responseEnd),
  };
}

const maskPairs = (pairs: Array<{ name: string; value: string }>, reveal: boolean): Array<[string, string]> =>
  pairs.map(({ name, value }) => [name, reveal ? value : maskValue(name, value)]);

export async function requestDetail(req: Request, reveal: boolean): Promise<RequestDetail> {
  const res = await req.response().catch(() => null);
  const contentType = res ? ((await res.headerValue('content-type').catch(() => null)) ?? null) : null;
  let body: string | null = null;
  let bodyNote: string | null = null;
  if (!res) bodyNote = req.failure() ? `Failed: ${req.failure()!.errorText}` : 'No response.';
  else if (res.status() >= 300 && res.status() < 400) bodyNote = 'A redirect has no body.';
  else {
    try {
      const buf = await res.body();
      if (isTextual(contentType)) {
        const text = clip(buf.toString('utf8'));
        body = reveal ? text : maskText(text);
      } else bodyNote = `${contentType ?? 'Binary'}, ${buf.length.toLocaleString('en-IN')} bytes: not shown as text.`;
    } catch {
      bodyNote = 'The browser no longer holds this response (the page moved on, or it was streamed).';
    }
  }
  const post = req.postData();
  const server = res ? await res.serverAddr().catch(() => null) : null;
  return {
    url: reveal ? req.url() : maskText(req.url()),
    method: req.method(),
    status: res?.status() ?? null,
    statusText: res?.statusText() ?? '',
    resourceType: req.resourceType(),
    remoteAddress: server ? `${server.ipAddress}:${server.port}` : null,
    requestHeaders: maskPairs(await req.headersArray().catch(() => []), reveal),
    responseHeaders: res ? maskPairs(await res.headersArray().catch(() => []), reveal) : [],
    postData: post === null ? null : reveal ? clip(post) : maskText(clip(post)),
    body,
    bodyNote,
    contentType,
    timing: res ? phases(req.timing()) : null,
    messages: [],
    masked: !reveal,
  };
}

// Sent as source text, not a function: the dev build wraps named inner functions in a helper
// (esbuild's keepNames) that does not exist in the page, and the call would fail there.
const READ_STORAGE = String.raw`function (max) {
  function read(s) {
    var out = [];
    for (var i = 0; i < s.length && out.length < max; i++) { var k = s.key(i); out.push([k, s.getItem(k) || '']); }
    return out;
  }
  // Storage throws on opaque origins (about:blank, sandboxed pages).
  function safe(get) { try { return read(get()); } catch (e) { return []; } }
  return { origin: location.origin, local: safe(function () { return localStorage; }), session: safe(function () { return sessionStorage; }) };
}`;

export async function storageSnapshot(context: BrowserContext, page: Page, reveal: boolean): Promise<StorageSnapshot> {
  const cut = (v: string) => (v.length > STORAGE_VALUE_LIMIT ? `${v.slice(0, STORAGE_VALUE_LIMIT)}…` : v);
  const hide = (k: string, v: string) => cut(reveal ? v : maskValue(k, v));
  const cookies = (await context.cookies()).slice(0, STORAGE_ENTRIES).map((c) => ({
    name: c.name,
    value: hide(c.name, c.value),
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
  const stores = await page
    .evaluate<{ origin: string; local: Array<[string, string]>; session: Array<[string, string]> }>(`(${READ_STORAGE})(${STORAGE_ENTRIES})`)
    .catch(() => ({ origin: '', local: [] as Array<[string, string]>, session: [] as Array<[string, string]> }));
  return {
    origin: stores.origin,
    cookies,
    local: stores.local.map(([k, v]) => [k, hide(k, v)]),
    session: stores.session.map(([k, v]) => [k, hide(k, v)]),
    masked: !reveal,
  };
}

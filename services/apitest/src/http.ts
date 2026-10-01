import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { ApiTimings } from '@tb/contracts';
import { guardedLookup, isPrivateAddress } from '@tb/platform';
import type { ConcreteRequest } from './resolve';

// Sends one request from the server (plan §2: the browser never calls target APIs). node:http rather
// than fetch because it takes a lookup hook, which is how the SSRF check pins the address actually
// connected to, and because it exposes the socket events the timing waterfall needs.

export interface SendOptions {
  allowPrivate: boolean;
  timeoutMs: number;
  followRedirects: boolean;
  /** Read at most this much of the body; the rest is dropped and the response marked truncated. */
  maxBodyBytes: number;
  /** Cookie handling across redirects: what to send to a URL, and what to do with what it sets. */
  cookies?: { header(url: URL): string | null; store(url: URL, setCookies: string[]): void } | undefined;
  /** Client certificate and CA for a URL, chosen per hop so a redirect to another host gets its own. */
  tls?: ((url: URL) => TlsMaterial | null) | undefined;
}

export interface TlsMaterial {
  cert?: string | undefined;
  key?: string | undefined;
  passphrase?: string | undefined;
  /** Replaces the public roots for this host, for a server whose certificate a private CA issued. */
  ca?: string | undefined;
}

export interface RawResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Buffer;
  truncated: boolean;
}

export interface SendOutcome {
  response: RawResponse | null;
  error: { code: string; message: string } | null;
  timings: ApiTimings;
  redirects: { status: number; url: string }[];
  /** Headers of the last hop, as sent (Cookie added by the jar included). */
  sentHeaders: [string, string][];
}

const MAX_REDIRECTS = 10;
// Credentials that must not follow a redirect to another origin, as browsers and fetch do.
const CROSS_ORIGIN_STRIP = new Set(['authorization', 'proxy-authorization', 'cookie']);

export function errorOf(err: NodeJS.ErrnoException, timedOut: boolean): { code: string; message: string } {
  if (timedOut) return { code: 'timeout', message: 'No response before the timeout.' };
  switch (err.code) {
    case 'EBLOCKED':
      return { code: 'blocked', message: `${err.message}. Requests to internal addresses are not allowed from Testbench.` };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { code: 'dns', message: `The host could not be found (${err.code}).` };
    case 'ECONNREFUSED':
      return { code: 'refused', message: 'The server refused the connection. Is it running, and is the port right?' };
    case 'ECONNRESET':
      return { code: 'reset', message: 'The server closed the connection before answering.' };
    default:
      if (err.code?.startsWith('ERR_TLS') || /CERT|SSL|self.signed/i.test(err.code ?? err.message))
        return { code: 'tls', message: `TLS failed: ${err.message}` };
      return { code: 'network', message: err.message };
  }
}

function decoded(res: IncomingMessage): NodeJS.ReadableStream {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'deflate') return res.pipe(createInflate());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  return res;
}

const pairs = (raw: string[]): [string, string][] => {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!]);
  return out;
};

interface Hop {
  res: IncomingMessage | null;
  body: Buffer;
  truncated: boolean;
  error: { code: string; message: string } | null;
}

export async function sendHttp(req: ConcreteRequest, opts: SendOptions): Promise<SendOutcome> {
  const started = performance.now();
  const timings: ApiTimings = { dnsMs: null, connectMs: null, tlsMs: null, firstByteMs: null, totalMs: 0 };
  const redirects: SendOutcome['redirects'] = [];
  const deadline = started + opts.timeoutMs;
  let url = new URL(req.url);
  let method = req.method;
  let body = req.body;
  let headers = req.headers;
  const origin = url.origin;

  for (let hop = 0; ; hop++) {
    const sent: [string, string][] = [...headers];
    const cookie = opts.cookies?.header(url);
    if (cookie && !sent.some(([k]) => k.toLowerCase() === 'cookie')) sent.push(['Cookie', cookie]);
    const result = await oneHop(url, method, sent, body, opts, Math.max(1, deadline - performance.now()), timings, started);
    timings.totalMs = Math.round(performance.now() - started);
    if (!result.res) return { response: null, error: result.error, timings, redirects, sentHeaders: sent };

    const res = result.res;
    const setCookies = res.headers['set-cookie'] ?? [];
    if (setCookies.length) opts.cookies?.store(url, setCookies);
    const location = res.headers.location;
    const status = res.statusCode ?? 0;
    if (opts.followRedirects && location && [301, 302, 303, 307, 308].includes(status)) {
      if (hop >= MAX_REDIRECTS)
        return { response: null, error: { code: 'redirects', message: `Stopped after ${MAX_REDIRECTS} redirects.` }, timings, redirects, sentHeaders: sent };
      const next = new URL(location, url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:')
        return { response: null, error: { code: 'redirects', message: `Redirect to ${next.protocol} is not followed.` }, timings, redirects, sentHeaders: sent };
      redirects.push({ status, url: next.toString() });
      // 303, and 301/302 after a POST, become a GET without a body, as every browser does.
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
        headers = headers.filter(([k]) => !['content-type', 'content-length'].includes(k.toLowerCase()));
      }
      if (next.origin !== origin) headers = headers.filter(([k]) => !CROSS_ORIGIN_STRIP.has(k.toLowerCase()));
      url = next;
      continue;
    }
    return {
      response: {
        status,
        statusText: res.statusMessage ?? '',
        headers: pairs(res.rawHeaders),
        body: result.body,
        truncated: result.truncated,
      },
      error: null,
      timings,
      redirects,
      sentHeaders: sent,
    };
  }
}

function oneHop(
  url: URL,
  method: string,
  headers: [string, string][],
  body: Buffer | null,
  opts: SendOptions,
  timeoutMs: number,
  timings: ApiTimings,
  started: number,
): Promise<Hop> {
  // Node skips the lookup hook for a literal IP, so http://169.254.169.254/ is checked here instead.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && isIP(literal) && isPrivateAddress(literal))
    return Promise.resolve({
      res: null,
      body: Buffer.alloc(0),
      truncated: false,
      error: errorOf(Object.assign(new Error(`${literal} is a private address`), { code: 'EBLOCKED' }), false),
    });
  return new Promise((resolve) => {
    let timedOut = false;
    const since = () => Math.round(performance.now() - started);
    // Raw header pairs keep duplicates and the tester's casing, but then Node adds no Host of its own.
    const flat: string[] = [];
    if (!headers.some(([k]) => k.toLowerCase() === 'host')) flat.push('Host', url.host);
    for (const [k, v] of headers) flat.push(k, v);
    if (body && !headers.some(([k]) => k.toLowerCase() === 'content-length')) flat.push('Content-Length', String(body.length));
    const https = url.protocol === 'https:';
    const tls = https ? opts.tls?.(url) : null;
    const send = https ? httpsRequest : httpRequest;
    const r = send(url, {
      method,
      headers: flat,
      lookup: guardedLookup(opts.allowPrivate) as never,
      // A self-signed certificate on a test server is a TLS error to show, not to hide: the fix is to
      // add its CA as a client certificate entry, not to turn checking off.
      rejectUnauthorized: true,
      ...(tls ? { cert: tls.cert, key: tls.key, passphrase: tls.passphrase, ca: tls.ca } : {}),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      r.destroy(new Error('timeout'));
    }, timeoutMs);
    r.on('socket', (socket) => {
      socket.once('lookup', () => (timings.dnsMs ??= since()));
      socket.once('connect', () => (timings.connectMs ??= since()));
      socket.once('secureConnect', () => (timings.tlsMs ??= since()));
    });
    r.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ res: null, body: Buffer.alloc(0), truncated: false, error: errorOf(err, timedOut) });
    });
    r.on('response', (res) => {
      timings.firstByteMs ??= since();
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const stream = decoded(res);
      const done = () => {
        clearTimeout(timer);
        resolve({ res, body: Buffer.concat(chunks), truncated, error: null });
      };
      stream.on('data', (chunk: Buffer) => {
        if (truncated) return;
        if (size + chunk.length > opts.maxBodyBytes) {
          chunks.push(chunk.subarray(0, opts.maxBodyBytes - size));
          truncated = true;
          res.destroy();
          done();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', () => !truncated && done());
      stream.on('error', (err: NodeJS.ErrnoException) => {
        if (truncated) return;
        clearTimeout(timer);
        resolve({ res: null, body: Buffer.alloc(0), truncated: false, error: timedOut ? errorOf(err, true) : { code: 'decode', message: `The response body could not be decoded: ${err.message}` } });
      });
    });
    r.end(body ?? undefined);
  });
}

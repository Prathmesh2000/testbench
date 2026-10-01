import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { StreamEvent, StreamResult } from '@tb/contracts';
import { guardedLookup, isPrivateAddress } from '@tb/platform';
import WebSocket from 'ws';
import { errorOf, type TlsMaterial } from './http';

// WebSocket and Server-Sent Events from the server (plan §2 and §21): connect, send what the request says,
// listen for a bounded time, and hand back a transcript the assertions can read. Same SSRF guard as every
// other send: the lookup hook pins the address, and an IP literal is checked here because Node skips the hook.

export interface StreamOptions {
  protocol: 'ws' | 'sse';
  url: string;
  method: string;
  headers: [string, string][];
  body: Buffer | null;
  messages: string[];
  listenMs: number;
  maxMessages: number;
  allowPrivate: boolean;
  tls?: TlsMaterial | null | undefined;
}

export type StreamOutcome = Pick<StreamResult, 'status' | 'responseHeaders' | 'requestHeaders' | 'events' | 'closeCode' | 'closeReason' | 'endedBy' | 'timings' | 'error' | 'truncated'>;

const MAX_EVENTS = 600;
const MAX_DATA = 64 * 1024;
const MAX_PAYLOAD = 1024 * 1024;
const CONNECT_MS = 15_000;

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** Incremental parser for the text/event-stream format: feed chunks, get complete events. */
export function sseParser() {
  let buffer = '';
  let data: string[] = [];
  let event = '';
  let id: string | null = null;
  let skipLf = false;
  const out: SseEvent[] = [];
  const line = (l: string) => {
    if (l === '') {
      if (data.length) out.push({ event: event || 'message', data: data.join('\n'), id });
      data = [];
      event = '';
      return;
    }
    if (l.startsWith(':')) return;
    const at = l.indexOf(':');
    const field = at < 0 ? l : l.slice(0, at);
    const value = at < 0 ? '' : l.slice(at + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id' && !value.includes('\0')) id = value;
  };
  return {
    push(chunk: string): SseEvent[] {
      out.length = 0;
      for (const ch of chunk) {
        if (skipLf) {
          skipLf = false;
          if (ch === '\n') continue;
        }
        if (ch === '\n') {
          line(buffer);
          buffer = '';
        } else if (ch === '\r') {
          line(buffer);
          buffer = '';
          skipLf = true;
        } else buffer += ch;
      }
      return [...out];
    },
  };
}

const pairs = (raw: string[]): [string, string][] => {
  const o: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) o.push([raw[i]!, raw[i + 1]!]);
  return o;
};

const cut = (s: string) => (s.length > MAX_DATA ? `${s.slice(0, MAX_DATA)}…` : s);

export async function runStream(o: StreamOptions): Promise<StreamOutcome> {
  const started = performance.now();
  const now = () => Math.round(performance.now() - started);
  const events: StreamEvent[] = [];
  const state = { status: null as number | null, responseHeaders: [] as [string, string][], closeCode: null as number | null, closeReason: null as string | null, connectMs: null as number | null, firstMessageMs: null as number | null, truncated: false, inbound: 0 };
  const done = (endedBy: StreamResult['endedBy'], error: StreamResult['error'] = null): StreamOutcome => ({
    status: state.status,
    responseHeaders: state.responseHeaders,
    requestHeaders: o.headers,
    events,
    closeCode: state.closeCode,
    closeReason: state.closeReason,
    endedBy,
    timings: { connectMs: state.connectMs, firstMessageMs: state.firstMessageMs, totalMs: now() },
    error,
    truncated: state.truncated,
  });

  const target = new URL(o.url.replace(/^ws/i, 'http'));
  const literal = target.hostname.replace(/^\[|\]$/g, '');
  if (!o.allowPrivate && isIP(literal) && isPrivateAddress(literal))
    return done('error', errorOf(Object.assign(new Error(`${literal} is a private address`), { code: 'EBLOCKED' }), false));

  const add = (e: StreamEvent) => {
    if (events.length >= MAX_EVENTS) {
      state.truncated = true;
      return;
    }
    events.push(e.data.length > MAX_DATA ? ((state.truncated = true), { ...e, data: cut(e.data) }) : e);
  };
  const inbound = (data: string, extra: { event?: string; id?: string } = {}) => {
    state.firstMessageMs ??= now();
    state.inbound++;
    add({ t: now(), kind: 'in', data, ...extra });
    return state.inbound >= o.maxMessages;
  };

  return o.protocol === 'ws' ? websocket(o, done, add, inbound, state, now) : sse(o, target, done, add, inbound, state, now);
}

type Done = (endedBy: StreamResult['endedBy'], error?: StreamResult['error']) => StreamOutcome;
type Shared = { status: number | null; responseHeaders: [string, string][]; closeCode: number | null; closeReason: string | null; connectMs: number | null };

function websocket(o: StreamOptions, done: Done, add: (e: StreamEvent) => void, inbound: (d: string) => boolean, state: Shared, now: () => number): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of o.headers) headers[k] = k in headers ? `${headers[k]}, ${v}` : v;
    const ws = new WebSocket(o.url, {
      headers,
      lookup: guardedLookup(o.allowPrivate) as never,
      handshakeTimeout: CONNECT_MS,
      maxPayload: MAX_PAYLOAD,
      followRedirects: false,
      rejectUnauthorized: true,
      ...(o.tls ? { cert: o.tls.cert, key: o.tls.key, passphrase: o.tls.passphrase, ca: o.tls.ca } : {}),
    });
    const finish = (by: StreamResult['endedBy'], error: StreamResult['error'] = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (by !== 'server' && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'done');
        setTimeout(() => ws.terminate(), 300).unref();
      } else if (by === 'error') ws.terminate();
      resolve(done(by, error));
    };
    ws.on('upgrade', (res) => {
      state.status = res.statusCode ?? 101;
      state.responseHeaders = pairs(res.rawHeaders);
    });
    ws.on('unexpected-response', (_req, res) => {
      state.status = res.statusCode ?? null;
      state.responseHeaders = pairs(res.rawHeaders);
      res.resume();
      finish('error', { code: 'handshake', message: `The server answered ${res.statusCode} instead of switching to a WebSocket.` });
    });
    ws.on('open', () => {
      state.connectMs = now();
      add({ t: now(), kind: 'open', data: '' });
      for (const m of o.messages) {
        ws.send(m);
        add({ t: now(), kind: 'out', data: m });
      }
      timer = setTimeout(() => finish('time'), o.listenMs);
    });
    ws.on('message', (data, isBinary) => {
      const text = isBinary ? `[binary, ${(data as Buffer).length} bytes]` : data.toString('utf8');
      if (inbound(text)) finish('messages');
    });
    ws.on('close', (code, reason) => {
      state.closeCode = code;
      state.closeReason = reason.toString('utf8') || null;
      add({ t: now(), kind: 'close', data: `${code}${state.closeReason ? ` ${state.closeReason}` : ''}` });
      finish('server');
    });
    ws.on('error', (err: NodeJS.ErrnoException) => {
      const timedOut = /handshake has timed out/i.test(err.message);
      const e = errorOf(err, timedOut);
      add({ t: now(), kind: 'error', data: e.message });
      finish('error', e);
    });
  });
}

function sse(o: StreamOptions, url: URL, done: Done, add: (e: StreamEvent) => void, inbound: (d: string, x?: { event?: string; id?: string }) => boolean, state: Shared, now: () => number): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const sent: [string, string][] = [...o.headers];
    const has = (k: string) => sent.some(([h]) => h.toLowerCase() === k);
    if (!has('accept')) sent.push(['Accept', 'text/event-stream']);
    if (!has('cache-control')) sent.push(['Cache-Control', 'no-cache']);
    sent.push(['Accept-Encoding', 'identity']);
    const flat: string[] = [];
    if (!has('host')) flat.push('Host', url.host);
    for (const [k, v] of sent) flat.push(k, v);
    if (o.body && !has('content-length')) flat.push('Content-Length', String(o.body.length));
    const https = url.protocol === 'https:';
    const req = (https ? httpsRequest : httpRequest)(url, {
      method: o.method,
      headers: flat,
      lookup: guardedLookup(o.allowPrivate) as never,
      rejectUnauthorized: true,
      ...(https && o.tls ? { cert: o.tls.cert, key: o.tls.key, passphrase: o.tls.passphrase, ca: o.tls.ca } : {}),
    });
    const finish = (by: StreamResult['endedBy'], error: StreamResult['error'] = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ...done(by, error), requestHeaders: sent });
    };
    const connect = setTimeout(() => finish('error', { code: 'timeout', message: 'No response before the timeout.' }), CONNECT_MS);
    req.on('response', (res) => {
      clearTimeout(connect);
      state.connectMs = now();
      state.status = res.statusCode ?? null;
      state.responseHeaders = pairs(res.rawHeaders);
      const type = String(res.headers['content-type'] ?? '');
      if ((res.statusCode ?? 0) !== 200 || !/text\/event-stream/i.test(type)) {
        res.resume();
        finish('error', { code: 'not_sse', message: (res.statusCode ?? 0) !== 200 ? `The server answered ${res.statusCode}, not an event stream.` : `The server answered 200 with ${type || 'no content type'}, not text/event-stream.` });
        return;
      }
      add({ t: now(), kind: 'open', data: '' });
      timer = setTimeout(() => finish('time'), o.listenMs);
      const decoder = new StringDecoder('utf8');
      const parser = sseParser();
      res.on('data', (chunk: Buffer) => {
        for (const e of parser.push(decoder.write(chunk))) {
          const stop = inbound(e.data, { event: e.event, ...(e.id !== null ? { id: e.id } : {}) });
          if (stop) return finish('messages');
        }
      });
      res.on('end', () => {
        add({ t: now(), kind: 'close', data: 'stream ended' });
        finish('server');
      });
      res.on('error', (err: NodeJS.ErrnoException) => finish('error', errorOf(err, false)));
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(connect);
      const e = errorOf(err, false);
      add({ t: now(), kind: 'error', data: e.message });
      finish('error', e);
    });
    if (o.body) req.write(o.body);
    req.end();
  });
}

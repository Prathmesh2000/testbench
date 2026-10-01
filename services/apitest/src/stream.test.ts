import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { buildRequest } from './resolve';
import { runStream, sseParser, type StreamOptions } from './stream';
import { transcriptFacts } from './streamRun';
import { evaluate } from './assert';
import type { ApiRequestDef } from '@tb/contracts';

describe('sseParser', () => {
  it('reads events across chunks, with ids, names and multi-line data', () => {
    const p = sseParser();
    expect(p.push('data: one\n\nevent: tick\nid: 7\nda')).toEqual([{ event: 'message', data: 'one', id: null }]);
    expect(p.push('ta: a\ndata: b\n\n: comment\n\n')).toEqual([{ event: 'tick', data: 'a\nb', id: '7' }]);
  });
  it('accepts CRLF and lone CR, and ignores events with no data', () => {
    const p = sseParser();
    expect(p.push('data: x\r\n\r\nevent: empty\n\ndata:y\r\r').map((e) => e.data)).toEqual(['x', 'y']);
  });
});

let http: Server;
let base: string;
const opts = (over: Partial<StreamOptions>): StreamOptions => ({ protocol: 'ws', url: '', method: 'GET', headers: [], body: null, messages: [], listenMs: 1500, maxMessages: 50, allowPrivate: true, ...over });

beforeAll(async () => {
  http = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        res.write(`id: ${++n}\nevent: tick\ndata: {"n":${n}}\n\n`);
        if (n >= 3) {
          clearInterval(t);
          res.end();
        }
      }, 20);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (req.url === '/endless') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => res.write('data: ping\n\n'), 10);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ type: 'ready', auth: req.headers.authorization ?? null }));
    ws.on('message', (m) => {
      if (m.toString() === 'bye') ws.close(4001, 'done');
      else ws.send(JSON.stringify({ type: 'echo', text: m.toString() }));
    });
  });
  http.on('upgrade', (req, socket, head) => {
    if (req.url === '/refused') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  base = `127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(() => {
  http.closeAllConnections();
  http.close();
});

describe('WebSocket', () => {
  it('connects with headers, sends messages in order and records the transcript', async () => {
    const out = await runStream(opts({ url: `ws://${base}/`, headers: [['Authorization', 'Bearer t']], messages: ['hello', 'world'], maxMessages: 3 }));
    expect(out.status).toBe(101);
    expect(out.endedBy).toBe('messages');
    expect(out.events.map((e) => e.kind)).toEqual(['open', 'out', 'out', 'in', 'in', 'in']);
    const facts = transcriptFacts(out);
    expect(facts.json).toEqual([{ type: 'ready', auth: 'Bearer t' }, { type: 'echo', text: 'hello' }, { type: 'echo', text: 'world' }]);
    expect(out.timings.connectMs).not.toBeNull();
    expect(out.timings.firstMessageMs).not.toBeNull();
  });

  it('checks no-code assertions against the messages', async () => {
    const out = await runStream(opts({ url: `ws://${base}/`, messages: ['x'], maxMessages: 2 }));
    const res = evaluate(
      [
        { id: 'a', source: 'status', path: '', op: 'eq', value: '101', enabled: true },
        { id: 'b', source: 'body', path: '$[1].type', op: 'eq', value: 'echo', enabled: true },
      ] as never,
      transcriptFacts(out),
    );
    expect(res.map((r) => r.passed)).toEqual([true, true]);
  });

  it('records the close the server sends', async () => {
    const out = await runStream(opts({ url: `ws://${base}/`, messages: ['bye'] }));
    expect(out.endedBy).toBe('server');
    expect(out.closeCode).toBe(4001);
    expect(out.closeReason).toBe('done');
  });

  it('stops listening when the time is up', async () => {
    const out = await runStream(opts({ url: `ws://${base}/`, listenMs: 300 }));
    expect(out.endedBy).toBe('time');
    expect(out.events.filter((e) => e.kind === 'in')).toHaveLength(1);
  });

  it('reports a refused handshake and a refused connection', async () => {
    const refused = await runStream(opts({ url: `ws://${base}/refused` }));
    expect(refused).toMatchObject({ status: 403, endedBy: 'error', error: { code: 'handshake' } });
    const none = await runStream(opts({ url: 'ws://127.0.0.1:1/' }));
    expect(none.error?.code).toBe('refused');
  });

  it('will not connect to a private address when that is not allowed', async () => {
    const out = await runStream(opts({ url: `ws://${base}/`, allowPrivate: false }));
    expect(out.error?.code).toBe('blocked');
    expect(out.events).toHaveLength(0);
    const meta = await runStream(opts({ url: 'ws://169.254.169.254/', allowPrivate: false }));
    expect(meta.error?.code).toBe('blocked');
    const name = await runStream(opts({ url: 'ws://localhost:1/', allowPrivate: false }));
    expect(name.error?.code).toBe('blocked');
  });
});

describe('Server-Sent Events', () => {
  it('collects named events with their ids until the server ends the stream', async () => {
    const out = await runStream(opts({ protocol: 'sse', url: `http://${base}/events` }));
    expect(out.status).toBe(200);
    expect(out.endedBy).toBe('server');
    expect(out.events.filter((e) => e.kind === 'in').map((e) => [e.event, e.id, e.data])).toEqual([
      ['tick', '1', '{"n":1}'],
      ['tick', '2', '{"n":2}'],
      ['tick', '3', '{"n":3}'],
    ]);
    expect(out.requestHeaders.find(([k]) => k === 'Accept')?.[1]).toBe('text/event-stream');
  });

  it('stops an endless stream by count or by time', async () => {
    const few = await runStream(opts({ protocol: 'sse', url: `http://${base}/endless`, maxMessages: 5 }));
    expect(few.endedBy).toBe('messages');
    expect(few.events.filter((e) => e.kind === 'in')).toHaveLength(5);
    const timed = await runStream(opts({ protocol: 'sse', url: `http://${base}/endless`, listenMs: 250 }));
    expect(timed.endedBy).toBe('time');
  });

  it('says so when the answer is not an event stream', async () => {
    const wrongType = await runStream(opts({ protocol: 'sse', url: `http://${base}/json` }));
    expect(wrongType.error?.code).toBe('not_sse');
    expect(wrongType.error?.message).toMatch(/application\/json/);
    const missing = await runStream(opts({ protocol: 'sse', url: `http://${base}/nowhere` }));
    expect(missing.error?.message).toMatch(/404/);
  });

  it('blocks private addresses like every other send', async () => {
    const out = await runStream(opts({ protocol: 'sse', url: `http://${base}/events`, allowPrivate: false }));
    expect(out.error?.code).toBe('blocked');
  });
});

describe('building a WebSocket request', () => {
  const def = (over: Partial<ApiRequestDef>): ApiRequestDef =>
    ({ method: 'GET', url: 'wss://{{host}}/live', params: [{ key: 'room', value: '{{room}}', enabled: true }], headers: [], body: { type: 'none' }, auth: { type: 'inherit' }, assertions: [], extractors: [], settings: { timeoutMs: 30000, followRedirects: true }, docs: '', scripts: { pre: '', post: '' }, operation: null, protocol: 'ws', stream: { send: ['join {{room}}'], listenMs: 5000, maxMessages: 50 }, ...over }) as ApiRequestDef;
  const scopes = [[{ key: 'host', value: 'api.test', secret: false, enabled: true }, { key: 'room', value: 'r1', secret: false, enabled: true }, { key: 'tok', value: 's3', secret: true, enabled: true }]];

  it('fills variables, keeps the ws scheme and adds auth and messages', () => {
    const r = buildRequest(def({}), { type: 'bearer', token: '{{tok}}' }, scopes);
    expect(r.url).toBe('wss://api.test/live?room=r1');
    expect(r.headers).toContainEqual(['Authorization', 'Bearer s3']);
    expect(r.messages).toEqual(['join r1']);
    expect(r.secrets).toContain('s3');
  });

  it('puts an api key in the query of a ws url', () => {
    const r = buildRequest(def({ url: 'ws://api.test:8080/x' }), { type: 'apikey', key: 'k', value: 'v', in: 'query' }, scopes);
    expect(r.url).toBe('ws://api.test:8080/x?room=r1&k=v');
  });

  it('wants ws for a socket and http for the rest', () => {
    expect(() => buildRequest(def({ url: 'https://api.test/x' }), { type: 'none' }, scopes)).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => buildRequest(def({ url: 'ws://api.test/x', protocol: undefined }), { type: 'none' }, scopes)).toThrow(/http:\/\/ or https:\/\//);
  });
});

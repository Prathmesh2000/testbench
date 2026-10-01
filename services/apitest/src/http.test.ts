import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendHttp, type SendOptions } from './http';
import { makeTestPki } from './test-pki';

// A local server stands in for the API under test; private addresses are allowed here, and one test
// checks they are refused when they are not.

let server: Server;
let base: string;
const seen: { url: string; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'sid=abc; Path=/' });
        res.end(JSON.stringify({ method: req.method, body }));
      });
      return;
    }
    if (u.pathname === '/moved') {
      res.writeHead(303, { location: '/echo' });
      return res.end();
    }
    if (u.pathname === '/away') {
      res.writeHead(302, { location: `http://127.0.0.2:${(server.address() as AddressInfo).port}/echo` });
      return res.end();
    }
    if (u.pathname === '/gzip') {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      return res.end(gzipSync('hello gzip'));
    }
    if (u.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(5000));
    }
    if (u.pathname === '/slow') return setTimeout(() => res.end('late'), 2000);
    res.writeHead(404).end();
  });
  // All interfaces, so 127.0.0.2 reaches it too and serves as a second origin.
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = (over: Partial<SendOptions> = {}): SendOptions => ({ allowPrivate: true, timeoutMs: 5000, followRedirects: true, maxBodyBytes: 1_000_000, ...over });
const req = (path: string, method = 'GET', body: string | null = null, headers: [string, string][] = []) => ({
  method,
  url: `${base}${path}`,
  headers,
  body: body === null ? null : Buffer.from(body),
  secrets: [],
  unresolved: [],
});

describe('sendHttp', () => {
  it('sends the body and returns status, headers and timings', async () => {
    const out = await sendHttp(req('/echo', 'POST', '{"a":1}', [['Content-Type', 'application/json']]), opts());
    expect(out.error).toBeNull();
    expect(out.response!.status).toBe(201);
    expect(JSON.parse(out.response!.body.toString())).toEqual({ method: 'POST', body: '{"a":1}' });
    expect(out.response!.headers).toContainEqual(['content-type', 'application/json']);
    expect(out.timings.firstByteMs).not.toBeNull();
  });

  it('turns a POST into a GET on 303 and records the hop', async () => {
    const out = await sendHttp(req('/moved', 'POST', 'x'), opts());
    expect(JSON.parse(out.response!.body.toString()).method).toBe('GET');
    expect(out.redirects).toEqual([{ status: 303, url: `${base}/echo` }]);
  });

  it('does not carry credentials to another origin on a redirect', async () => {
    seen.length = 0;
    await sendHttp(req('/away', 'GET', null, [['Authorization', 'Bearer t']]), opts());
    expect(seen[0]!.headers.authorization).toBe('Bearer t');
    expect(seen[1]!.headers.authorization).toBeUndefined();
  });

  it('can leave redirects alone', async () => {
    const out = await sendHttp(req('/moved'), opts({ followRedirects: false }));
    expect(out.response!.status).toBe(303);
  });

  it('decompresses gzip and cuts an oversized body', async () => {
    expect((await sendHttp(req('/gzip', 'GET', null, [['Accept-Encoding', 'gzip']]), opts())).response!.body.toString()).toBe('hello gzip');
    const big = await sendHttp(req('/big'), opts({ maxBodyBytes: 1000 }));
    expect(big.response!.body.length).toBe(1000);
    expect(big.response!.truncated).toBe(true);
  });

  it('uses the cookie hooks across calls', async () => {
    const jar: string[] = [];
    const cookies = { header: () => (jar.length ? jar.join('; ') : null), store: (_u: URL, set: string[]) => jar.push(...set.map((s) => s.split(';')[0]!)) };
    await sendHttp(req('/echo', 'POST', ''), opts({ cookies }));
    seen.length = 0;
    await sendHttp(req('/echo', 'POST', ''), opts({ cookies }));
    expect(seen[0]!.headers.cookie).toBe('sid=abc');
  });

  it('reports a timeout, and refuses private addresses unless allowed', async () => {
    expect((await sendHttp(req('/slow'), opts({ timeoutMs: 200 }))).error?.code).toBe('timeout');
    const blocked = await sendHttp(req('/echo'), opts({ allowPrivate: false }));
    expect(blocked.error?.code).toBe('blocked');
    expect(blocked.response).toBeNull();
  });
});

describe('client certificates', () => {
  it('sends the client certificate a server demands, and trusts a private CA only when given', async () => {
    const pki = makeTestPki();
    const tlsServer = createHttpsServer({ key: pki.serverKey, cert: pki.serverCert, ca: pki.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      res.end(`hello ${peer.subject?.CN}`);
    });
    await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
    const url = `https://localhost:${(tlsServer.address() as AddressInfo).port}/`;
    const get = { method: 'GET', url, headers: [] as [string, string][], body: null, secrets: [], unresolved: [] };
    try {
      expect((await sendHttp(get, opts())).error?.code).toBe('tls');
      expect((await sendHttp(get, opts({ tls: () => ({ ca: pki.ca }) }))).error).not.toBeNull();
      const ok = await sendHttp(get, opts({ tls: () => ({ ca: pki.ca, cert: pki.clientCert, key: pki.clientKeyEncrypted, passphrase: 'pass' }) }));
      expect(ok.error).toBeNull();
      expect(ok.response!.body.toString()).toBe('hello api-tester');
    } finally {
      await new Promise<void>((r) => tlsServer.close(() => r()));
    }
  });
});

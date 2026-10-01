import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiEnvironment, ApiNodeDetail, ApiSpecDetail, ApiWorkspace, SendResult, SpecUploadResult } from '@tb/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { makeTestPki } from '@tb/apitest/test-pki';
import { schedulerPass } from '@tb/apitest';
import { call, JIRA_SANDBOX, startHarness, type Harness } from './harness';

// API Studio against the local stack, with a small HTTP server started here as the API under test.

let h: Harness;
let target: Server;
let targetUrl: string;
const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
// The token /auth/token issued last; older ones get a 401, which is how a stale session is simulated.
let tokens = 0;
// The deliberately weak API the security checks attack, and what its owner says it publishes to prove it.
let vulnFixed = false;
let verifyToken = 'unset';
// Fails every other call, to show a retry turning a failure into a flaky pass.
let flakyCalls = 0;
// A tiny stateful shop for workflow runs: create, read, update and delete orders.
const orders = new Map<string, Record<string, unknown>>();
const secItems = new Map<string, Record<string, unknown>>();
// The workflow made from the secured spec, which the load tests run.
let secWorkflowId = '';

beforeAll(async () => {
  h = await startHarness();
  target = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      if (req.url === '/live/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: hello\ndata: {"user":"' + (req.headers.authorization ?? 'anon') + '"}\n\n');
        res.end('event: bye\ndata: {"ok":true}\n\n');
        return;
      }
      if (req.url === '/.well-known/testbench-verify.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(verifyToken);
      }
      if (req.url?.startsWith('/vuln/')) {
        const u = new URL(req.url, 'http://x');
        const origin = req.headers.origin;
        const cors = origin && !vulnFixed ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {};
        const send = (code: number, b: unknown, type = 'application/json') => {
          res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...cors });
          res.end(typeof b === 'string' ? b : JSON.stringify(b));
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          return res.end();
        }
        // Fixed: only the real token gets in. Weak: any token, or none, does.
        if (vulnFixed && req.headers.authorization !== 'Bearer super-secret-token') return send(401, { error: 'unauthorised' });
        if (u.pathname.startsWith('/vuln/docs/')) return send(200, { id: u.pathname.split('/').pop(), owner: 'alice', text: 'a private document' });
        if (u.pathname === '/vuln/admin/stats') return send(200, { users: 5 });
        if (u.pathname === '/vuln/users' && req.method === 'POST') return send(201, { id: 'u1', ...(body ? JSON.parse(body) : {}) });
        if (u.pathname === '/vuln/search') {
          const q = u.searchParams.get('q') ?? '';
          if (!vulnFixed && /['"]/.test(q)) return send(500, `You have an error in your SQL syntax near '${q}'`, 'text/plain');
          return send(200, { results: [] });
        }
      }
      if (req.url?.startsWith('/sec/')) {
        const send = (code: number, b?: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(b === undefined ? '' : JSON.stringify(b));
        };
        if (req.url === '/sec/login') return send(200, { access_token: 'sec-token' });
        if (req.headers.authorization !== 'Bearer sec-token') return send(401, { error: 'no token' });
        const m = /^\/sec\/items(?:\/([^/?]+))?/.exec(req.url);
        if (!m) return send(404, {});
        if (!m[1] && req.method === 'POST') {
          const id = `i${secItems.size + 1}`;
          secItems.set(id, JSON.parse(body || '{}'));
          return send(201, { id });
        }
        if (!secItems.has(m[1]!)) return send(404, {});
        if (req.method === 'DELETE') {
          secItems.delete(m[1]!);
          return send(204);
        }
        return send(200, { id: m[1], ...secItems.get(m[1]!) });
      }
      const shop = /^\/shop\/orders(?:\/([^/?]+))?/.exec(req.url ?? '');
      if (shop) {
        const id = shop[1];
        const json = (code: number, b?: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(b === undefined ? '' : JSON.stringify(b));
        };
        if (!id && req.method === 'POST') {
          const o = { id: `o${orders.size + 1}`, ...(body ? JSON.parse(body) : {}) };
          orders.set(o.id, o);
          return json(201, o);
        }
        if (!id || !orders.has(id)) return json(404, { error: 'not found' });
        if (req.method === 'GET') return json(200, orders.get(id));
        if (req.method === 'PATCH') return json(200, Object.assign(orders.get(id)!, body ? JSON.parse(body) : {}));
        if (req.method === 'DELETE') {
          orders.delete(id);
          return json(204);
        }
      }
      if (req.url === '/flaky') {
        res.writeHead(++flakyCalls % 2 === 1 ? 500 : 200);
        return res.end();
      }
      if (req.url === '/auth/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: `tok-${++tokens}` }));
      }
      if (req.url === '/secure') {
        const ok = req.headers.authorization === `Bearer tok-${tokens}`;
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(ok ? { secret: 'data' } : { error: 'bad token' }));
      }
      if (req.url === '/web/login') {
        res.writeHead(200, { 'set-cookie': ['sid=web-1; Path=/; HttpOnly', 'XSRF-TOKEN=x1; Path=/'] });
        return res.end();
      }
      if (req.url === '/web/write') {
        const ok = /sid=web-1/.test(req.headers.cookie ?? '') && req.headers['x-xsrf-token'] === 'x1';
        res.writeHead(ok ? 200 : 403);
        return res.end(ok ? 'written' : 'csrf');
      }
      if (req.url === '/login') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=session-1; Path=/; HttpOnly' });
        return res.end(JSON.stringify({ token: 'issued-token' }));
      }
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ord_1', echo: body ? JSON.parse(body) : null }));
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ type: 'welcome', auth: req.headers.authorization ?? null }));
    ws.on('message', (m) => ws.send(JSON.stringify({ type: 'echo', text: m.toString() })));
  });
  target.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req)));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
}, 30_000);
afterAll(async () => {
  await new Promise<void>((r) => target?.close(() => r()));
  await h?.close();
});

const base = () => `/projects/${h.projectId}/apitest`;
const last = () => seen[seen.length - 1]!;

describe('API Studio', () => {
  let ws: ApiWorkspace;
  let env: ApiEnvironment;
  let collection: ApiNodeDetail;
  let request: ApiNodeDetail;

  it('shares team workspaces in the project and keeps them read-only for viewers', async () => {
    const created = await call<ApiWorkspace>(h, h.users.tester, 'POST', `${base()}/workspaces`, { name: 'Orders team' });
    expect(created.status).toBe(201);
    ws = created.body;
    expect((await call(h, h.users.viewer, 'GET', `${base()}/workspaces`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: ws.id })]));
    expect((await call(h, h.users.viewer, 'POST', `${base()}/workspaces`, { name: 'Nope' })).status).toBe(403);
    expect((await call(h, h.users.outsider, 'GET', `${base()}/workspaces`)).status).toBe(404);
  });

  it('hides a personal workspace from everyone but its owner', async () => {
    const mine = await call<ApiWorkspace>(h, h.users.tester, 'POST', `${base()}/workspaces`, { name: 'Scratch', kind: 'personal' });
    expect((await call(h, h.users.lead, 'GET', `${base()}/workspaces/${mine.body.id}/tree`)).status).toBe(404);
    expect((await call(h, h.users.tester, 'GET', `${base()}/workspaces/${mine.body.id}/tree`)).status).toBe(200);
  });

  it('stores secrets encrypted and never returns them', async () => {
    const res = await call<ApiEnvironment>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/environments`, {
      name: 'local',
      variables: [
        { key: 'baseUrl', value: targetUrl },
        { key: 'token', value: 'super-secret-token', secret: true },
      ],
    });
    expect(res.status).toBe(201);
    env = res.body;
    expect(env.variables[1]).toMatchObject({ key: 'token', value: '', secret: true, hasValue: true });
    const row = await h.owner.selectFrom('apitest.environment').select('variables').where('id', '=', env.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(row.variables)).not.toContain('super-secret-token');

    // Saving again with the secret left blank keeps it.
    const again = await call<ApiEnvironment>(h, h.users.tester, 'PUT', `${base()}/workspaces/${ws.id}/environments/${env.id}`, {
      name: 'local',
      variables: env.variables.map((v) => ({ ...v, hasValue: undefined })),
    });
    expect(again.body.variables[1]!.hasValue).toBe(true);
  });

  it('builds a tree where requests inherit the collection auth, and sends with secrets masked in history', async () => {
    collection = (
      await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, {
        kind: 'collection',
        name: 'Orders',
        config: { auth: { type: 'bearer', token: '{{token}}' }, variables: [] },
      })
    ).body;
    const folder = (await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, { kind: 'folder', name: 'Create', parentId: collection.id })).body;
    const res = await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, {
      kind: 'request',
      name: 'Create order',
      parentId: folder.id,
      request: {
        method: 'POST',
        url: '{{baseUrl}}/orders',
        body: { type: 'json', text: '{"qty": 2}' },
        assertions: [
          { id: 'a1', source: 'status', op: 'eq', value: '201' },
          { id: 'a2', source: 'body', path: '$.echo.qty', op: 'eq', value: '3' },
        ],
        extractors: [{ variable: 'orderId', source: 'body', path: '$.id' }],
      },
    });
    expect(res.status).toBe(201);
    request = res.body;

    const sent = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
      request: request.request,
      nodeId: request.id,
      environmentId: env.id,
    });
    expect(sent.status).toBe(200);
    expect(last().headers.authorization).toBe('Bearer super-secret-token');
    expect(sent.body.response?.status).toBe(201);
    expect(sent.body.assertions.map((a) => a.passed)).toEqual([true, false]);
    expect(sent.body.assertions[1]!.message).toContain('but it is 2');
    expect(sent.body.extracted).toEqual({ orderId: 'ord_1' });
    expect(JSON.stringify(sent.body)).not.toContain('super-secret-token');

    const history = await h.owner.selectFrom('apitest.history').selectAll().where('id', '=', sent.body.historyId).executeTakeFirstOrThrow();
    expect(JSON.stringify(history)).not.toContain('super-secret-token');
  });

  it('uses values the browser holds as locals, most specific first', async () => {
    const sent = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
      request: { ...request.request!, url: '{{baseUrl}}/orders/{{orderId}}', method: 'GET', body: { type: 'none' } },
      nodeId: request.id,
      environmentId: env.id,
      locals: { orderId: 'ord_1' },
    });
    expect(sent.body.response?.status).toBe(200);
    expect(last().path).toBe('/orders/ord_1');
  });

  it('keeps a login cookie in the saved jar, and sends none when told not to', async () => {
    const login = { method: 'POST', url: '{{baseUrl}}/login', auth: { type: 'none' } };
    const first = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: login, environmentId: env.id });
    expect(first.body.cookiesSet).toEqual(['sid']);
    expect(JSON.stringify(first.body.response?.headers)).not.toContain('session-1');

    const next = { method: 'GET', url: '{{baseUrl}}/me', auth: { type: 'none' } };
    await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: next, environmentId: env.id });
    expect(last().headers.cookie).toBe('sid=session-1');
    const jar = await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/cookies?environmentId=${env.id}`);
    expect(jar.body).toEqual([expect.objectContaining({ name: 'sid', httpOnly: true })]);
    // The jar is the tester's own: a teammate sending the same request has none.
    await call(h, h.users.lead, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: next, environmentId: env.id });
    expect(last().headers.cookie).toBeUndefined();

    await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: next, environmentId: env.id, cookies: 'none' });
    expect(last().headers.cookie).toBeUndefined();
  });

  it('sends a variation with its overrides and the rest inherited', async () => {
    const list = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes/${request.id}/variations`, {
      name: 'Zero items',
      overrides: { body: { type: 'json', text: '{"qty": 0}' } },
    });
    expect(list.status).toBe(201);
    await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
      request: request.request,
      nodeId: request.id,
      variationId: list.body[0].id,
      environmentId: env.id,
    });
    expect(last().body).toBe('{"qty": 0}');
    expect(last().headers.authorization).toBe('Bearer super-secret-token');
  });

  it('runs collection and request scripts around a send, with secrets masked in their output', async () => {
    await call(h, h.users.tester, 'PATCH', `${base()}/workspaces/${ws.id}/nodes/${collection.id}`, {
      config: {
        auth: { type: 'bearer', token: '{{token}}' },
        variables: [],
        scripts: { pre: "tb.request.headers.add({ key: 'X-Sig', value: tb.crypto.sha256('body') }); console.log('token is', tb.variables.get('token'));", post: '' },
      },
    });
    const sent = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
      request: {
        ...request.request!,
        scripts: {
          pre: "pm.variables.set('qty', 5);",
          post: "pm.test('created', () => pm.response.to.have.status(201)); pm.environment.set('lastOrder', pm.response.json().id);",
        },
        body: { type: 'json', text: '{"qty": {{qty}}}' },
      },
      nodeId: request.id,
      environmentId: env.id,
    });
    expect(sent.body.scriptErrors).toEqual([]);
    expect(last().headers['x-sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(last().body).toBe('{"qty": 5}');
    expect(sent.body.assertions).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'created', passed: true })]));
    expect(sent.body.extracted).toMatchObject({ qty: '5', lastOrder: 'ord_1' });
    expect(sent.body.logs[0]!.text).toBe('token is ••••••');
    expect(JSON.stringify(sent.body)).not.toContain('super-secret-token');
  });

  it('lets a pre script fetch a token with pm.sendRequest before the request goes out', async () => {
    const sent = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
      request: {
        method: 'GET',
        url: '{{baseUrl}}/secure',
        auth: { type: 'none' },
        scripts: {
          pre: "pm.sendRequest({ url: tb.variables.get('baseUrl') + '/auth/token', method: 'POST' }, (err, res) => { tb.request.headers.upsert({ key: 'Authorization', value: 'Bearer ' + res.json().access_token }); });",
          post: '',
        },
      },
      environmentId: env.id,
    });
    expect(sent.body.scriptErrors).toEqual([]);
    expect(sent.body.response?.status).toBe(200);
  });

  it('does not send when a pre-request script fails', async () => {
    const before = seen.length;
    const sent = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
      request: { ...request.request!, scripts: { pre: "throw new Error('no signing key')", post: '' } },
      nodeId: request.id,
      environmentId: env.id,
    });
    expect(seen.length).toBe(before);
    expect(sent.body.response).toBeNull();
    expect(sent.body.error).toMatchObject({ code: 'script' });
    expect(sent.body.error!.message).toContain('no signing key');
  });

  it('refuses to move a folder inside itself', async () => {
    const outer = (await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, { kind: 'folder', name: 'Outer', parentId: collection.id })).body;
    const inner = (await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, { kind: 'folder', name: 'Inner', parentId: outer.id })).body;
    expect((await call(h, h.users.tester, 'PATCH', `${base()}/workspaces/${ws.id}/nodes/${outer.id}`, { parentId: inner.id })).status).toBe(400);
  });

  describe('import, export, duplicate and snippets', () => {
    it('imports a Postman collection and environment, and a cURL command, with warnings', async () => {
      const postman = {
        info: { name: 'From Postman', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ name: 'Folder', item: [{ name: 'Ping', request: { method: 'GET', url: '{{baseUrl}}/ping' }, event: [{ listen: 'test', script: { exec: ['pm.setNextRequest(null)'] } }] }] }],
      };
      const col = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/import`, { format: 'postman', content: JSON.stringify(postman) });
      expect(col.status).toBe(201);
      expect(col.body).toMatchObject({ kind: 'collection', name: 'From Postman', requests: 1 });
      expect(col.body.warnings[0]).toMatch(/setNextRequest/);

      const env = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/import`, {
        format: 'postman-environment',
        content: JSON.stringify({ name: 'staging', values: [{ key: 'apiKey', value: 'k-123', type: 'secret', enabled: true }] }),
      });
      expect(env.body).toMatchObject({ kind: 'environment', name: 'staging' });
      const stored = await h.owner.selectFrom('apitest.environment').select('variables').where('id', '=', env.body.id).executeTakeFirstOrThrow();
      expect(JSON.stringify(stored.variables)).not.toContain('k-123');

      const curl = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/import`, {
        format: 'curl',
        content: `curl -X POST '${targetUrl}/orders' -H 'content-type: application/json' --data-raw '{"qty":7}'`,
        parentId: col.body.id,
      });
      expect(curl.body).toMatchObject({ kind: 'request', requests: 1 });
      const node = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${curl.body.id}`);
      expect(node.body.request).toMatchObject({ method: 'POST', body: { type: 'json', text: '{"qty":7}' } });

      expect((await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/import`, { format: 'postman', content: '{"nope": 1}' })).status).toBe(400);
      expect((await call(h, h.users.viewer, 'POST', `${base()}/workspaces/${ws.id}/import`, { format: 'postman', content: JSON.stringify(postman) })).status).toBe(403);
    });

    it('exports a collection as Postman with secret values left out', async () => {
      await call(h, h.users.tester, 'PATCH', `${base()}/workspaces/${ws.id}/nodes/${collection.id}`, {
        config: { auth: { type: 'bearer', token: '{{token}}' }, variables: [{ key: 'colSecret', value: 'hidden-value', secret: true }], scripts: { pre: '', post: '' } },
      });
      const out = await call(h, h.users.viewer, 'GET', `${base()}/workspaces/${ws.id}/nodes/${collection.id}/export`);
      expect(out.status).toBe(200);
      expect(out.body.info.schema).toContain('v2.1.0');
      expect(JSON.stringify(out.body)).not.toContain('hidden-value');
      expect(JSON.stringify(out.body)).toContain('Create order');
    });

    it('duplicates a request with its variations', async () => {
      const dup = await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes/${request.id}/duplicate`);
      expect(dup.status).toBe(201);
      expect(dup.body).toMatchObject({ name: 'Create order (copy)', parentId: request.parentId });
      expect(dup.body.variations.map((v) => v.name)).toEqual(['Zero items']);
    });

    it('writes a snippet of the resolved request with secrets masked', async () => {
      const res = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/snippet`, {
        request: { ...request.request!, scripts: { pre: '', post: '' } },
        nodeId: request.id,
        environmentId: env.id,
        language: 'curl',
      });
      expect(res.status).toBe(200);
      expect(res.body.code).toContain(`${targetUrl}/orders`);
      expect(res.body.code).toContain('Authorization: Bearer ••••••');
      expect(res.body.code).not.toContain('super-secret-token');
    });
  });

  describe('auth profiles and certificates', () => {
    const send = (request: object, extra: object = {}) =>
      call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request, environmentId: env.id, ...extra });
    const node = async (name: string, request: object) =>
      (await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, { kind: 'request', name, parentId: collection.id, request })).body;

    it('logs in once, reuses the session, and logs in again on a 401', async () => {
      const login = await node('Get token', { method: 'POST', url: '{{baseUrl}}/auth/token', auth: { type: 'none' } });
      const profile = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/profiles`, {
        name: 'Token',
        loginNodeId: login.id,
        config: { extract: { source: 'body', path: '$.access_token' }, apply: { as: 'bearer' } },
      });
      expect(profile.status).toBe(201);
      const secure = { method: 'GET', url: '{{baseUrl}}/secure', auth: { type: 'profile', profileId: profile.body.id } };

      const first = await send(secure);
      expect(first.body.response?.status).toBe(200);
      expect(first.body.login).toMatchObject({ reason: 'no_session', status: 200 });
      expect(JSON.stringify(first.body)).not.toContain(`tok-${tokens}`);
      const stored = await h.owner.selectFrom('apitest.auth_session').select('token_enc').where('profile_id', '=', profile.body.id).executeTakeFirstOrThrow();
      expect(stored.token_enc).not.toContain('tok-');

      const second = await send(secure);
      expect(second.body.response?.status).toBe(200);
      expect(second.body.login).toBeNull();

      tokens++; // the server moves on; the stored token is now stale
      const third = await send(secure);
      expect(third.body.login).toMatchObject({ reason: 'unauthorized' });
      expect(third.body.response?.status).toBe(200);

      // Sessions are per tester: a teammate logs in on their own.
      const lead = await call<SendResult>(h, h.users.lead, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: secure, environmentId: env.id });
      expect(lead.body.login).toMatchObject({ reason: 'no_session' });
    });

    it('keeps a cookie session and sends the CSRF header on writes', async () => {
      const login = await node('Web login', { method: 'POST', url: '{{baseUrl}}/web/login', auth: { type: 'none' } });
      const profile = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/profiles`, {
        name: 'Browser session',
        loginNodeId: login.id,
        config: { extract: { source: 'cookie', path: 'sid' }, apply: { as: 'cookie' }, csrf: { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' } },
      });
      const write = await send({ method: 'POST', url: '{{baseUrl}}/web/write', auth: { type: 'profile', profileId: profile.body.id } }, { cookies: 'none' });
      expect(write.body.login).toMatchObject({ reason: 'no_session' });
      expect(write.body.response?.status).toBe(200);
      expect(last().headers['x-xsrf-token']).toBe('x1');
    });

    it('refuses a login that itself uses a profile, and a missing login', async () => {
      const profiles = await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/profiles`);
      const looped = await node('Loop', { method: 'GET', url: '{{baseUrl}}/x', auth: { type: 'profile', profileId: profiles.body[0].id } });
      const bad = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/profiles`, {
        name: 'Loop', loginNodeId: looped.id, config: { extract: { source: 'body', path: '$.t' }, apply: { as: 'bearer' } },
      });
      expect(bad.status).toBe(400);
      expect((await call(h, h.users.viewer, 'POST', `${base()}/workspaces/${ws.id}/profiles`, { name: 'x', loginNodeId: looped.id, config: { extract: { source: 'body', path: '$.t' }, apply: { as: 'bearer' } } })).status).toBe(403);
    });

    it('stores client certificates encrypted and checks the key matches', async () => {
      const pki = makeTestPki();
      const ok = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/certificates`, { name: 'Bank sandbox', host: '*.bank.test', cert: pki.clientCert, key: pki.clientKey });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ subject: 'CN=api-tester', hasClientCert: true, hasCa: false });
      const row = await h.owner.selectFrom('apitest.client_cert').select('bundle_enc').where('id', '=', ok.body.id).executeTakeFirstOrThrow();
      expect(row.bundle_enc).not.toContain('PRIVATE KEY');
      const mismatch = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/certificates`, { name: 'x', host: 'x.test', cert: pki.clientCert, key: pki.serverKey });
      expect(mismatch.status).toBe(400);
      const list = await call(h, h.users.viewer, 'GET', `${base()}/workspaces/${ws.id}/certificates`);
      expect(JSON.stringify(list.body)).not.toContain('BEGIN');
    });
  });

  describe('project map and workflows', () => {
    const shopSpec = () => `openapi: 3.0.3
info: { title: Shop, version: '1' }
servers: [{ url: '${targetUrl}/shop' }]
paths:
  /orders:
    post:
      tags: [orders]
      summary: Create order
      responses: { '201': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: string } } } } } } }
  /orders/{orderId}:
    get: { tags: [orders], summary: Get order, parameters: [{ name: orderId, in: path, required: true }], responses: { '200': { description: ok } } }
    patch: { tags: [orders], summary: Update order, parameters: [{ name: orderId, in: path, required: true }], responses: { '200': { description: ok } } }
    delete: { tags: [orders], summary: Delete order, parameters: [{ name: orderId, in: path, required: true }], responses: { '204': { description: gone } } }
`;
    let workflowId: string;
    const wfBase = () => `${base()}/workspaces/${ws.id}/workflows`;
    const waitFor = async (runId: string) => {
      for (let i = 0; i < 50; i++) {
        const r = await call(h, h.users.tester, 'GET', `${wfBase()}/${workflowId}/runs/${runId}`);
        if (r.body.status !== 'running') return r.body;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      throw new Error('run did not finish');
    };

    it('maps the operations and links the create to the calls that use its id', async () => {
      expect((await call(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Shop', content: shopSpec() })).status).toBe(201);
      const map = await call(h, h.users.viewer, 'GET', `${base()}/map`);
      expect(map.status).toBe(200);
      const link = map.body.links.find((l: { to: string; param: { name: string } }) => l.to === 'GET /orders/{orderId}' && l.param.name === 'orderId');
      expect(link).toMatchObject({ from: 'POST /orders', field: '$.id' });
      expect(map.body.order.indexOf('POST /orders')).toBeLessThan(map.body.order.indexOf('DELETE /orders/{orderId}'));
      expect(map.body.suggestions.map((s: { id: string }) => s.id)).toContain('crud:POST /orders');
      expect((await call(h, h.users.outsider, 'GET', `${base()}/map`)).status).toBe(404);
    });

    it('makes a workflow from the CRUD suggestion and runs it to the final 404', async () => {
      const wf = await call(h, h.users.tester, 'POST', `${wfBase()}/from-suggestion`, { suggestionId: 'crud:POST /orders' });
      expect(wf.status).toBe(201);
      workflowId = wf.body.id;
      expect(wf.body.def.steps).toHaveLength(6);
      expect(wf.body.def.steps[0].assign).toEqual([{ variable: 'orderId', source: 'body', path: '$.id' }]);
      expect(wf.body.def.steps[5].variationId).not.toBeNull();

      // The imported collection needs {{baseUrl}}; the spec's server was set on it.
      const run = await call(h, h.users.tester, 'POST', `${wfBase()}/${workflowId}/runs`, { environmentId: null });
      expect(run.status).toBe(201);
      const done = await waitFor(run.body.id);
      expect(done.status).toBe('passed');
      // The six steps, then the teardown: the cleanup runs after the delete too, and its 404 is accepted.
      expect(done.results.map((r: { httpStatus: number }) => r.httpStatus)).toEqual([201, 200, 200, 200, 204, 404, null, 404]);
      expect(done.results.slice(6).map((r: { status: string }) => r.status)).toEqual(['passed', 'passed']);
      expect(wf.body.def.teardown).toHaveLength(1);
      expect(done.results[0].assigned.orderId).toMatch(/^o\d+$/);
      expect((await call(h, h.users.tester, 'GET', `${wfBase()}`)).body[0].lastRun.status).toBe('passed');
    });

    it('runs step by step, keeping the variables between steps', async () => {
      const run = await call(h, h.users.tester, 'POST', `${wfBase()}/${workflowId}/runs`, { mode: 'step' });
      expect(run.body.status).toBe('paused');
      const one = await call(h, h.users.tester, 'POST', `${wfBase()}/${workflowId}/runs/${run.body.id}/step`);
      expect(one.body).toMatchObject({ status: 'paused', next: 1 });
      const two = await call(h, h.users.tester, 'POST', `${wfBase()}/${workflowId}/runs/${run.body.id}/step`);
      expect(two.body.results[1]).toMatchObject({ status: 'passed', httpStatus: 200 });
      const cancelled = await call(h, h.users.tester, 'POST', `${wfBase()}/${workflowId}/runs/${run.body.id}/cancel`);
      expect(cancelled.body.status).toBe('cancelled');
      // Runs are the tester's own.
      expect((await call(h, h.users.lead, 'GET', `${wfBase()}/${workflowId}/runs/${run.body.id}`)).status).toBe(404);
    });

    it('fails a run at the broken step and says why', async () => {
      const wf = await call(h, h.users.tester, 'GET', `${wfBase()}/${workflowId}`);
      const steps = wf.body.def.steps.map((s: Record<string, unknown>, i: number) => (i === 0 ? { ...s, assign: [] } : s));
      await call(h, h.users.tester, 'PUT', `${wfBase()}/${workflowId}`, { name: wf.body.name, description: '', def: { ...wf.body.def, steps } });
      const run = await call(h, h.users.tester, 'POST', `${wfBase()}/${workflowId}/runs`, {});
      const done = await waitFor(run.body.id);
      expect(done.status).toBe('failed');
      expect(done.version).toBe(2);
      // The teardown still ran after it, so the failed step is the last of the main steps, not of the list.
      expect(done.results.filter((r: { status: string }) => r.status === 'failed').map((r: { stepId: string }) => r.stepId)).toEqual(['s2']);
    });

    it('logs in first from the spec’s security scheme, so a generated workflow can reach secured operations', async () => {
      const secSpec = `openapi: 3.0.3
info: { title: Secure, version: '1' }
servers: [{ url: '${targetUrl}/sec' }]
components:
  securitySchemes: { bearer: { type: http, scheme: bearer } }
paths:
  /login:
    post: { tags: [auth], summary: Log in, security: [], responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { access_token: { type: string } } } } } } } }
  /items:
    post:
      tags: [items]
      summary: Create item
      security: [{ bearer: [] }]
      requestBody: { content: { application/json: { schema: { type: object, required: [name], properties: { name: { type: string }, qty: { type: integer } } } } } }
      responses: { '201': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: string } } } } } } }
  /items/{itemId}:
    get: { tags: [items], summary: Get item, security: [{ bearer: [] }], parameters: [{ name: itemId, in: path, required: true }], responses: { '200': { description: ok } } }
    delete: { tags: [items], summary: Delete item, security: [{ bearer: [] }], parameters: [{ name: itemId, in: path, required: true }], responses: { '204': { description: gone } } }
`;
      expect((await call(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Secure', content: secSpec })).status).toBe(201);
      const wf = await call(h, h.users.tester, 'POST', `${wfBase()}/from-suggestion`, { suggestionId: 'crud:POST /items' });
      expect(wf.status).toBe(201);
      expect(wf.body.def.steps.map((s: { name: string }) => s.name)).toEqual(['Log in', 'Create an item', 'Read it back', 'Delete it', 'It is gone']);
      // The collection carries the scheme's auth, the login stays public, and the create starts from a body the schema accepts.
      const tree = (await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`)).body;
      const col = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${tree.find((n: { name: string; kind: string }) => n.name === 'Secure' && n.kind === 'collection').id}`);
      expect(col.body.config?.auth).toEqual({ type: 'bearer', token: '{{token}}' });
      const login = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${tree.find((n: { name: string }) => n.name === 'Log in').id}`);
      expect(login.body.request?.auth).toEqual({ type: 'none' });
      const create = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${tree.find((n: { name: string }) => n.name === 'Create item').id}`);
      expect(create.body.request?.auth).toEqual({ type: 'inherit' });
      expect(JSON.parse((create.body.request!.body as { text: string }).text)).toHaveProperty('name');

      secWorkflowId = wf.body.id;
      const run = await call(h, h.users.tester, 'POST', `${wfBase()}/${wf.body.id}/runs`, { environmentId: null });
      let done: { status: string; results: { httpStatus: number | null; status: string }[] } | null = null;
      for (let i = 0; i < 50 && !done; i++) {
        const r = await call(h, h.users.tester, 'GET', `${wfBase()}/${wf.body.id}/runs/${run.body.id}`);
        if (r.body.status !== 'running') done = r.body;
        else await new Promise((ok) => setTimeout(ok, 200));
      }
      expect(done?.status).toBe('passed');
      // Login, create, read, delete, "it is gone", then the cleanup (an if step, then its delete, which answers 404 and is accepted).
      expect(done?.results.map((r) => r.httpStatus)).toEqual([200, 201, 200, 204, 404, null, 404]);
    });

    it('ends a run as failed when a step that was allowed to fail did', async () => {
      const wf = await call(h, h.users.tester, 'POST', wfBase(), {
        name: 'Allowed failure',
        def: { steps: [], teardown: [], variables: [] },
      });
      const tree = (await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`)).body;
      const get = tree.find((n: { name: string }) => n.name === 'Get item');
      const steps = [
        { id: 'a', name: 'Missing item', kind: 'request', requestId: get.id, variationId: null, assign: [], continueOnFail: true },
        { id: 'b', name: 'Again', kind: 'request', requestId: get.id, variationId: null, assign: [], continueOnFail: true },
      ];
      await call(h, h.users.tester, 'PUT', `${wfBase()}/${wf.body.id}`, { name: 'Allowed failure', description: '', def: { steps, teardown: [], variables: [{ key: 'itemId', value: 'nope', secret: false, enabled: true }, { key: 'token', value: 'sec-token', secret: false, enabled: true }] } });
      const run = await call(h, h.users.tester, 'POST', `${wfBase()}/${wf.body.id}/runs`, {});
      let done: { status: string; results: { status: string }[] } | null = null;
      for (let i = 0; i < 50 && !done; i++) {
        const r = await call(h, h.users.tester, 'GET', `${wfBase()}/${wf.body.id}/runs/${run.body.id}`);
        if (r.body.status !== 'running') done = r.body;
        else await new Promise((ok) => setTimeout(ok, 200));
      }
      expect(done?.results.map((r) => r.status)).toEqual(['failed', 'failed']);
      expect(done?.status).toBe('failed');
    });

    it('checks responses against the spec and reports drift', async () => {
      const tree = await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`);
      // There is also a hand-made "Create order"; the one from the spec is the one with an operation.
      let node: { body: ApiNodeDetail } | null = null;
      let create: { id: string } | null = null;
      for (const n of tree.body.filter((x: { name: string }) => x.name === 'Create order')) {
        const d = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${n.id}`);
        if (d.body.request?.operation?.path === '/orders') [node, create] = [d, n];
      }
      expect(node).not.toBeNull();
      // The shop answers with every body field echoed back; the spec only documents id.
      const sent = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, {
        request: { ...node!.body.request!, body: { type: 'json', text: '{"qty": 2}' } },
        nodeId: create!.id,
      });
      expect(sent.body.response?.status).toBe(201);
      expect(sent.body.drift).toMatchObject({ operation: 'POST /orders', status: 201 });
      expect(sent.body.drift!.issues).toEqual([{ path: '$.qty', kind: 'extra', expected: 'not in the spec', actual: 'integer' }]);
      // Plain requests not made from a spec have nothing to drift from.
      const plain = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: { method: 'GET', url: `${targetUrl}/me`, auth: { type: 'none' } } });
      expect(plain.body.drift).toBeNull();
    });

    it('lets a tester reject a link, and refuses workflows that point outside the workspace', async () => {
      const decision = { from: 'POST /orders', to: 'GET /orders/{orderId}', param: { in: 'path', name: 'orderId' }, field: '$.id', status: 'rejected' };
      expect((await call(h, h.users.tester, 'POST', `${base()}/map/links`, decision)).status).toBe(204);
      const map = await call(h, h.users.tester, 'GET', `${base()}/map`);
      expect(map.body.links.find((l: { to: string; param: { name: string } }) => l.to === 'GET /orders/{orderId}' && l.param.name === 'orderId')).toBeUndefined();
      expect((await call(h, h.users.viewer, 'POST', `${base()}/map/links`, decision)).status).toBe(403);

      const bad = await call(h, h.users.tester, 'POST', wfBase(), {
        name: 'Bad',
        def: { steps: [{ id: 'a', kind: 'request', requestId: '00000000-0000-4000-8000-000000000099' }] },
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('quality, enrichment and generated tests', () => {
    const thin = `openapi: 3.0.3
info: { title: Thin, version: '1' }
paths:
  /carts:
    post:
      summary: Create cart
      requestBody: { content: { application/json: { schema: { type: object, properties: { qty: { type: integer }, note: { type: string } } } } } }
      responses: { '201': { description: ok } }
`;
    let specId: string;
    const sbase = () => `${base()}/specs/${specId}`;
    const q = async (kind: string, field?: string) => {
      const v = await call(h, h.users.tester, 'GET', `${sbase()}/enrichment`);
      return v.body.questions.find((x: { kind: string; field: string | null }) => x.kind === kind && (field === undefined || x.field === field));
    };

    it('scores the spec and lets a project switch a rule off with a reason', async () => {
      specId = (await call(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Thin', content: thin })).body.spec.id;
      const report = await call(h, h.users.viewer, 'GET', `${sbase()}/quality`);
      expect(report.status).toBe(200);
      expect(report.body.score).toBeLessThan(100);
      expect(report.body.issues.map((i: { rule: string }) => i.rule)).toEqual(expect.arrayContaining(['security-defined', 'op-error-response', 'version-present']));
      expect((await call(h, h.users.tester, 'PUT', `${base()}/quality/rules`, { rule: 'version-present', enabled: false })).status).toBe(400);
      expect((await call(h, h.users.tester, 'PUT', `${base()}/quality/rules`, { rule: 'version-present', enabled: false, reason: 'Internal API, one version' })).status).toBe(204);
      const again = await call(h, h.users.viewer, 'GET', `${sbase()}/quality`);
      expect(again.body.issues.some((i: { rule: string }) => i.rule === 'version-present')).toBe(false);
      expect(again.body.rules.find((r: { id: string }) => r.id === 'version-present')).toMatchObject({ enabled: false, reason: 'Internal API, one version' });
      expect((await call(h, h.users.viewer, 'PUT', `${base()}/quality/rules`, { rule: 'op-summary', enabled: false, reason: 'x x x' })).status).toBe(403);
    });

    it('asks about the gaps, keeps answers as an overlay and raises readiness', async () => {
      const before = await call(h, h.users.tester, 'GET', `${sbase()}/enrichment`);
      expect(before.body.readiness).toBe(0);
      const sec = await q('security');
      const res = await call(h, h.users.tester, 'POST', `${sbase()}/enrichment/answer`, { questionId: sec.id, answer: { kind: 'security', scheme: null, roles: [] } });
      expect(res.status).toBe(200);
      const qty = await q('constraints', 'qty');
      await call(h, h.users.tester, 'POST', `${sbase()}/enrichment/answer`, { questionId: qty.id, answer: { kind: 'constraints', minimum: 1, maximum: 5 } });
      const after = await call(h, h.users.tester, 'GET', `${sbase()}/enrichment`);
      expect(after.body.readiness).toBeGreaterThan(0);
      expect(after.body.counts.answered).toBe(2);
      const eff = await call(h, h.users.viewer, 'GET', `${sbase()}/effective`);
      expect(eff.body.paths['/carts'].post.requestBody.content['application/json'].schema.properties.qty).toEqual({ type: 'integer', minimum: 1, maximum: 5 });
      expect(eff.body.paths['/carts'].post.security).toEqual([]);

      const bad = await call(h, h.users.tester, 'POST', `${sbase()}/enrichment/answer`, { questionId: qty.id, answer: { kind: 'constraints', minimum: 9, maximum: 1 } });
      expect(bad.status).toBe(400);
      const wrongKind = await call(h, h.users.tester, 'POST', `${sbase()}/enrichment/answer`, { questionId: qty.id, answer: { kind: 'business_rule', text: 'x' } });
      expect(wrongKind.status).toBe(400);
      const skipped = await call(h, h.users.tester, 'POST', `${sbase()}/enrichment/status`, { questionId: (await q('side_effect'))?.id ?? (await q('business_rule')).id, status: 'skipped', assignTo: h.users.lead.id });
      expect(skipped.body.counts.skipped).toBe(1);
      expect((await call(h, h.users.viewer, 'POST', `${sbase()}/enrichment/answer`, { questionId: qty.id, answer: { kind: 'constraints', minimum: 1 } })).status).toBe(403);
    });

    it('drafts an answer with AI for the tester to accept', async () => {
      const example = await q('example');
      const draft = await call(h, h.users.tester, 'POST', `${sbase()}/enrichment/draft`, { questionId: example.id });
      expect(draft.status).toBe(200);
      expect(draft.body.answer.kind).toBe('example');
      expect(draft.body.ai.status).toBe('used');
    });

    it('generates tests from the effective spec, accepts them into requests and counts coverage', async () => {
      const gen = await call(h, h.users.tester, 'POST', `${sbase()}/tests/generate`, {});
      expect(gen.status).toBe(200);
      const names = gen.body.tests.map((t: { name: string }) => t.name);
      // The qty range came from the enrichment answer, not the upload.
      expect(names).toEqual(expect.arrayContaining(['qty just above the maximum (6)', 'qty at the minimum (1)', 'Happy path']));
      expect(names.some((n: string) => n === 'Without a credential')).toBe(false);

      const happy = gen.body.tests.find((t: { kind: string }) => t.kind === 'happy');
      const tooBig = gen.body.tests.find((t: { name: string }) => t.name === 'qty just above the maximum (6)');
      const reviewed = await call(h, h.users.tester, 'POST', `${sbase()}/tests/review`, { ids: [happy.id, tooBig.id], decision: 'accept', workspaceId: ws.id });
      expect(reviewed.body.counts.accepted).toBe(2);
      const accepted = reviewed.body.tests.find((t: { id: string }) => t.id === happy.id);
      const node = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${accepted.requestId}`);
      expect(node.body.variations.map((v) => v.name)).toEqual(expect.arrayContaining(['Happy path', 'qty just above the maximum (6)']));

      const other = gen.body.tests.find((t: { kind: string }) => t.kind === 'wrong_type');
      await call(h, h.users.tester, 'POST', `${sbase()}/tests/review`, { ids: [other.id], decision: 'reject' });
      const regen = await call(h, h.users.tester, 'POST', `${sbase()}/tests/generate`, {});
      expect(regen.body.tests.find((t: { id: string }) => t.id === other.id).status).toBe('rejected');

      const cov = await call(h, h.users.viewer, 'GET', `${sbase()}/coverage`);
      expect(cov.body.rows[0].cells['201']).toBe('covered');
      expect(cov.body.totals.percent).toBeGreaterThan(0);
    });
  });

  describe('suites, schedules and monitors', () => {
    const sb = () => `${base()}/workspaces/${ws.id}/suites`;
    let flakyReq: ApiNodeDetail;
    let dataReq: ApiNodeDetail;
    let suiteId: string;
    const req = async (name: string, request: object) =>
      (await call<ApiNodeDetail>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes`, { kind: 'request', name, parentId: collection.id, request })).body;

    it('runs a suite with retries, counting a pass after a retry as flaky, and fails on a broken check', async () => {
      flakyReq = await req('Flaky', { method: 'GET', url: `${targetUrl}/flaky`, auth: { type: 'none' }, assertions: [{ id: 's', source: 'status', op: 'eq', value: '200' }] });
      const suite = await call(h, h.users.tester, 'POST', sb(), {
        name: 'Smoke',
        items: [{ kind: 'request', requestId: flakyReq.id }, { kind: 'request_all', requestId: request.id }],
        settings: { retries: 1, parallel: 2, environmentId: env.id },
      });
      expect(suite.status).toBe(201);
      suiteId = suite.body.id;
      const run = await call(h, h.users.tester, 'POST', `${sb()}/${suiteId}/runs`, { wait: true });
      expect(run.status).toBe(200);
      expect(run.body).toMatchObject({ trigger: 'ci', status: 'failed' });
      const flaky = run.body.results.find((r: { name: string }) => r.name === 'Flaky');
      expect(flaky).toMatchObject({ status: 'passed', flaky: true, attempts: 2 });
      // "Create order" checks $.echo.qty is 3 but sends 2: a real failure, retried and still failing.
      const broken = run.body.results.find((r: { name: string }) => r.name === 'Create order');
      expect(broken).toMatchObject({ status: 'failed', attempts: 2 });
      expect(broken.message).toContain('but it is 2');
      expect(run.body.results.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['Create order · Zero items']));
      expect(run.body.totals).toMatchObject({ flaky: 1 });
      expect(run.body.totals.failed).toBeGreaterThanOrEqual(1);
    });

    it('exports JUnit and an HTML report, and shows the trend', async () => {
      const runs = await call(h, h.users.viewer, 'GET', `${sb()}/${suiteId}/runs`);
      const runId = runs.body[0].id;
      const xmlRes = await h.app.inject({ method: 'GET', url: `/api/v1${sb()}/${suiteId}/runs/${runId}/junit`, headers: { authorization: `Bearer ${h.users.viewer.token}` } });
      expect(xmlRes.headers['content-type']).toContain('application/xml');
      expect(xmlRes.body).toContain('<testsuites name="Smoke"');
      expect(xmlRes.body).toContain('<failure');
      const htmlRes = await h.app.inject({ method: 'GET', url: `/api/v1${sb()}/${suiteId}/runs/${runId}/report`, headers: { authorization: `Bearer ${h.users.viewer.token}` } });
      expect(htmlRes.body).toContain('<h1>Smoke</h1>');
      expect(htmlRes.body).not.toContain('super-secret-token');
      const trend = await call(h, h.users.viewer, 'GET', `${sb()}/${suiteId}/trend`);
      expect(trend.body.runs).toHaveLength(1);
      expect(trend.body.requests[0].failures + trend.body.requests[0].flaky).toBeGreaterThan(0);
    });

    it('runs once per data row with the columns as variables, and skips the rest after a failure when told to', async () => {
      const ds = await h.owner
        .insertInto('repo.data_set')
        .values({ org_id: h.orgId, project_id: h.projectId, name: `Quantities ${Date.now()}`, columns: ['qty'], rows: JSON.stringify([{ qty: '1' }, { qty: '2' }]), updated_by: h.users.tester.id, updated_at: new Date(), created_at: new Date() })
        .returning('id')
        .executeTakeFirstOrThrow();
      dataReq = await req('Order per row', { method: 'POST', url: `${targetUrl}/orders`, auth: { type: 'none' }, body: { type: 'json', text: '{"qty": {{qty}}}' }, assertions: [{ id: 's', source: 'status', op: 'eq', value: '201' }] });
      const suite = await call(h, h.users.tester, 'POST', sb(), { name: 'Data driven', items: [{ kind: 'request', requestId: dataReq.id }], settings: { dataSetId: ds.id } });
      const run = await call(h, h.users.tester, 'POST', `${sb()}/${suite.body.id}/runs`, { wait: true });
      expect(run.body.status).toBe('passed');
      expect(run.body.results.map((r: { row: number }) => r.row).sort()).toEqual([0, 1]);

      const stop = await call(h, h.users.tester, 'POST', sb(), { name: 'Stop early', items: [{ kind: 'request', requestId: request.id }, { kind: 'request', requestId: dataReq.id }], settings: { stopOnFail: true, environmentId: env.id } });
      const stopped = await call(h, h.users.tester, 'POST', `${sb()}/${stop.body.id}/runs`, { wait: true });
      expect(stopped.body.results.map((r: { status: string }) => r.status)).toEqual(['failed', 'skipped']);
    });

    it('starts monitors from the scheduler, and refuses a bad schedule', async () => {
      const monitor = await call(h, h.users.tester, 'POST', sb(), { name: 'Uptime', items: [{ kind: 'request', requestId: flakyReq.id }], settings: { retries: 1 }, schedule: { monitor: { everyMinutes: 5, maxP95Ms: 60000 } } });
      expect(monitor.status).toBe(201);
      const due = new Date(monitor.body.nextRunAt).getTime();
      expect(due - Date.now()).toBeGreaterThan(4 * 60_000);
      const started = await schedulerPass({ db: h.appDb, storage: h.storage, box: null, cfg: { allowPrivate: true }, log: { error: () => undefined } }, new Date(due + 1000));
      expect(started).toHaveLength(1);
      let run;
      for (let i = 0; i < 40; i++) {
        run = await call(h, h.users.tester, 'GET', `${sb()}/${monitor.body.id}/runs/${started[0]}`);
        if (run.body.status !== 'running') break;
        await new Promise((ok) => setTimeout(ok, 200));
      }
      expect(run!.body).toMatchObject({ trigger: 'monitor', status: 'passed' });
      // The next run moved on, so the same pass does not start it twice.
      expect(await schedulerPass({ db: h.appDb, storage: h.storage, box: null, cfg: { allowPrivate: true }, log: { error: () => undefined } }, new Date(due + 2000))).toEqual([]);

      const bad = await call(h, h.users.tester, 'POST', sb(), { name: 'Bad cron', items: [{ kind: 'request', requestId: flakyReq.id }], schedule: { cron: '99 * * * *' } });
      expect(bad.status).toBe(400);
    });

    it('files a Jira bug from a failed result, with the masked request and response', async () => {
      await call(h, h.users.tester, 'PUT', '/me/jira', { siteUrl: JIRA_SANDBOX.siteUrl, email: h.users.tester.email, apiToken: JIRA_SANDBOX.apiToken });
      const runs = await call(h, h.users.tester, 'GET', `${sb()}/${suiteId}/runs`);
      const run = await call(h, h.users.tester, 'GET', `${sb()}/${suiteId}/runs/${runs.body.at(-1).id}`);
      const failed = run.body.results.find((r: { status: string }) => r.status === 'failed');
      const bug = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/history/${failed.historyId}/bug`, {
        summary: 'Create order echoes the wrong quantity',
        failures: [failed.message],
        found: 'suite Smoke',
      });
      expect(bug.status).toBe(201);
      expect(bug.body.jiraKey).toMatch(/^[A-Z]+-\d+$/);
      const issue = await h.jira.getIssue(bug.body.jiraKey);
      // The sandbox keeps the whole issue as sent; the typed client only declares the fields it reads.
      const description = JSON.stringify((issue.fields as Record<string, unknown>).description ?? issue.fields);
      expect(description).toContain('POST');
      expect(description).not.toContain('super-secret-token');
    });

    it('keeps suites read-only for viewers and invisible outside the organisation', async () => {
      expect((await call(h, h.users.viewer, 'POST', `${sb()}/${suiteId}/runs`, {})).status).toBe(403);
      expect((await call(h, h.users.outsider, 'GET', sb())).status).toBe(404);
    });
  });

  describe('mock server', () => {
    const catalog = `openapi: 3.0.3
info: { title: Catalog, version: '1' }
paths:
  /items/{itemId}:
    get:
      parameters: [{ name: itemId, in: path, required: true }, { name: currency, in: query, required: true, schema: { type: string } }]
      responses:
        '200': { description: ok, content: { application/json: { example: { id: item-1, price: 499 } } } }
        '404': { description: none, content: { application/json: { example: { error: not found } } } }
  /items:
    post:
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [name], properties: { name: { type: string } } } } } }
      responses: { '201': { description: ok, content: { application/json: { example: { id: item-2 } } } }, '422': { description: bad } }
`;
    let specId: string;
    let url: string;
    const path = () => new URL(url).pathname;
    const hit = (method: string, rest: string, headers: Record<string, string> = {}, payload?: unknown) =>
      h.app.inject({ method: method as 'GET', url: `${path()}${rest}`, headers, payload: payload as object | undefined });

    it('stays off until switched on, then answers from the spec with no login at all', async () => {
      specId = (await call(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Catalog', content: catalog })).body.spec.id;
      expect((await call(h, h.users.viewer, 'GET', `${base()}/specs/${specId}/mock`)).body).toMatchObject({ url: null, enabled: false });
      const saved = await call(h, h.users.tester, 'PUT', `${base()}/specs/${specId}/mock`, { enabled: false, config: {}, overrides: {} });
      expect(saved.status).toBe(200);
      url = saved.body.url;
      expect(url).toContain('/api/v1/apitest/mock/');
      const off = await hit('GET', '/items/1?currency=INR');
      expect(off.statusCode).toBe(404);
      expect(off.json().error).toMatch(/switched off/);

      await call(h, h.users.tester, 'PUT', `${base()}/specs/${specId}/mock`, { enabled: true, config: {}, overrides: {} });
      const ok = await hit('GET', '/items/1?currency=INR');
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ id: 'item-1', price: 499 });
      expect(ok.headers['x-mock-operation']).toBe('GET /items/{itemId}');
      expect(ok.headers['access-control-allow-origin']).toBe('*');
      expect((await hit('OPTIONS', '/items')).statusCode).toBe(204);
    });

    it('answers a status the caller asks for, validates when told to, and applies overrides', async () => {
      expect((await hit('GET', '/items/1', { prefer: 'code=404' })).json()).toEqual({ error: 'not found' });
      expect((await hit('POST', '/items', {}, {})).statusCode).toBe(201);
      await call(h, h.users.tester, 'PUT', `${base()}/specs/${specId}/mock`, {
        enabled: true,
        config: { validate: true, latencyMs: 20 },
        overrides: { 'GET /items/{itemId}': { status: 200, body: '{"id":"fixed","price":1}', delayMs: 0 }, 'GET /nowhere': { status: 500, body: '', delayMs: 0 } },
      });
      expect((await hit('GET', '/items/1')).statusCode).toBe(400);
      const withQuery = await hit('GET', '/items/1?currency=INR');
      expect(withQuery.json()).toEqual({ id: 'fixed', price: 1 });
      const refused = await hit('POST', '/items', { 'content-type': 'application/json' }, { other: 1 });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toMatch(/Missing required field name/);
      expect((await hit('GET', '/unknown/route')).json().error).toMatch(/No operation in the spec matches/);
      const view = await call(h, h.users.viewer, 'GET', `${base()}/specs/${specId}/mock`);
      // Overrides for operations that are not in the spec are dropped on save.
      expect(Object.keys(view.body.overrides)).toEqual(['GET /items/{itemId}']);
      const log = await call(h, h.users.viewer, 'GET', `${base()}/specs/${specId}/mock/log`);
      expect(log.body[0]).toMatchObject({ method: 'GET', path: '/unknown/route', status: 404 });
    });

    it('follows spec answers and new versions at once, and a rotated URL kills the old one', async () => {
      // Answering "does it need a credential?" changes the effective spec; the mock must see it now.
      await call(h, h.users.tester, 'PUT', `${base()}/specs/${specId}/mock`, { enabled: true, config: { enforceAuth: true }, overrides: {} });
      expect((await hit('POST', '/items', { 'content-type': 'application/json' }, { name: 'x' })).statusCode).toBe(201);
      const sec = (await call(h, h.users.tester, 'GET', `${base()}/specs/${specId}/enrichment`)).body.questions.find((x: { kind: string; operation: string }) => x.kind === 'security' && x.operation === 'POST /items');
      await call(h, h.users.tester, 'POST', `${base()}/specs/${specId}/enrichment/answer`, { questionId: sec.id, answer: { kind: 'security', scheme: 'bearer', roles: [] } });
      expect((await hit('POST', '/items', { 'content-type': 'application/json' }, { name: 'x' })).statusCode).toBe(401);
      expect((await hit('POST', '/items', { 'content-type': 'application/json', authorization: 'Bearer t' }, { name: 'x' })).statusCode).toBe(201);
      // A new version with a changed example shows through straight away.
      await call(h, h.users.tester, 'POST', `${base()}/specs/${specId}/versions`, { content: catalog.replace('{ id: item-2 }', '{ id: item-99 }') });
      expect((await hit('POST', '/items', { 'content-type': 'application/json', authorization: 'Bearer t' }, { name: 'x' })).json()).toEqual({ id: 'item-99' });
      const old = path();
      const rotated = await call(h, h.users.tester, 'POST', `${base()}/specs/${specId}/mock/rotate`);
      url = rotated.body.url;
      expect(path()).not.toBe(old);
      expect((await h.app.inject({ method: 'GET', url: `${old}/items/1?currency=INR` })).statusCode).toBe(404);
      expect((await hit('GET', '/items/1?currency=INR')).statusCode).toBe(200);
      expect((await call(h, h.users.viewer, 'PUT', `${base()}/specs/${specId}/mock`, { enabled: false, config: {}, overrides: {} })).status).toBe(403);
      expect((await call(h, h.users.outsider, 'GET', `${base()}/specs/${specId}/mock`)).status).toBe(404);
    });
  });

  describe('the safety gate and security checks', () => {
    const vuln = () => `openapi: 3.0.3
info: { title: Vuln, version: '1' }
servers: [{ url: '${targetUrl}' }]
paths:
  /vuln/docs/{docId}:
    get: { tags: [docs], summary: Get a document, parameters: [{ name: docId, in: path, required: true }], responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { id: { type: string } } } } } } } }
  /vuln/admin/stats:
    get: { tags: [admin], summary: Admin statistics, responses: { '200': { description: ok } } }
  /vuln/users:
    post:
      tags: [users]
      summary: Create a user
      requestBody: { content: { application/json: { schema: { type: object, properties: { name: { type: string } } } } } }
      responses: { '201': { description: ok } }
  /vuln/search:
    get: { tags: [search], summary: Search, parameters: [{ name: q, in: query, required: true, schema: { type: string } }], responses: { '200': { description: ok } } }
`;
    let specId: string;
    let profileB: string;
    let prodEnv: ApiEnvironment;
    const sec = () => `${base()}/specs/${specId}/security`;
    const runBody = (over: object = {}) => ({ workspaceId: ws.id, environmentId: env.id, values: { docId: 'd1' }, otherProfileId: profileB, lowProfileId: profileB, ...over });
    const finish = async (runId: string) => {
      for (let i = 0; i < 120; i++) {
        const r = await call(h, h.users.tester, 'GET', `${sec()}/runs/${runId}`);
        if (r.body.status !== 'running') return r.body;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      throw new Error('security run did not finish');
    };

    it('refuses an unverified host, and lets one through once its owner proves it', async () => {
      specId = (await call(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Vuln API', content: vuln() })).body.spec.id;
      const imported = await call(h, h.users.tester, 'POST', `${base()}/specs/${specId}/import`, { workspaceId: ws.id });
      expect(imported.body.created).toBe(4);
      await call(h, h.users.tester, 'PATCH', `${base()}/workspaces/${ws.id}/nodes/${imported.body.collectionId}`, { config: { auth: { type: 'bearer', token: '{{token}}' }, variables: [{ key: 'baseUrl', value: targetUrl }], scripts: { pre: '', post: '' } } });
      const login = (await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`)).body.find((n: { name: string }) => n.name === 'Get token');
      const cfg = { extract: { source: 'body', path: '$.access_token' }, apply: { as: 'bearer' } };
      await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/profiles`, { name: 'Alice', loginNodeId: login.id, config: cfg });
      profileB = (await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/profiles`, { name: 'Bob', loginNodeId: login.id, config: cfg })).body.id;

      // The gate applies to hosts that are not local development hosts; the sandbox's own host is local here, so
      // this checks the verification flow itself against the test API.
      const host = new URL(targetUrl).host;
      const t = await call(h, h.users.tester, 'POST', `${base()}/targets`, { host });
      expect(t.status).toBe(201);
      expect(t.body).toMatchObject({ status: 'pending', host });
      expect(t.body.challenge.dns.name).toBe('_testbench-challenge.127.0.0.1');
      expect((await call(h, h.users.tester, 'POST', `${base()}/targets`, { host })).status).toBe(409);
      expect((await call(h, h.users.tester, 'POST', `${base()}/targets/${t.body.id}/verify`, { method: 'file' })).status).toBe(422);
      verifyToken = t.body.challenge.token;
      const verified = await call(h, h.users.tester, 'POST', `${base()}/targets/${t.body.id}/verify`, { method: 'file' });
      expect(verified.body).toMatchObject({ status: 'verified', method: 'file' });
      expect((await call(h, h.users.viewer, 'POST', `${base()}/targets`, { host: 'other.test' })).status).toBe(403);
    });

    it('guards production: refused without an override, and only an admin can give one', async () => {
      prodEnv = (await call<ApiEnvironment>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/environments`, { name: 'prod-like', production: true, variables: [{ key: 'baseUrl', value: targetUrl }, { key: 'token', value: 'super-secret-token', secret: true }] })).body;
      expect(prodEnv.production).toBe(true);
      const denied = await call(h, h.users.tester, 'POST', `${sec()}/runs`, runBody({ environmentId: prodEnv.id }));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('production_guard');
      const notAdmin = await call(h, h.users.tester, 'POST', `${sec()}/runs`, runBody({ environmentId: prodEnv.id, productionOverride: true }));
      expect(notAdmin.body.error.message).toMatch(/admin/);
      const admin = await call(h, h.users.admin, 'POST', `${sec()}/runs`, runBody({ environmentId: prodEnv.id, productionOverride: true, checks: ['cors'] }));
      expect(admin.status).toBe(201);
      await new Promise((ok) => setTimeout(ok, 800));
      const audit = await h.owner.selectFrom('outbox.event').select('data').where('org_id', '=', h.orgId).where('type', '=', 'apitest.security.run').execute();
      expect(audit.some((e) => (e.data as { override?: boolean }).override === true)).toBe(true);
    });

    it('finds each weakness the test API has, with masked evidence', async () => {
      const started = await call(h, h.users.tester, 'POST', `${sec()}/runs`, runBody());
      expect(started.status).toBe(201);
      const run = await finish(started.body.id);
      expect(run.status).toBe('done');
      const rules = run.findings.map((f: { rule: string }) => f.rule);
      expect(rules).toEqual(expect.arrayContaining(['auth-bypass', 'bfla', 'bola', 'mass-assignment', 'injection', 'cors-origin', 'no-rate-limit']));
      const highs = run.findings.filter((f: { severity: string }) => f.severity === 'high').length;
      expect(highs).toBeGreaterThanOrEqual(5);
      expect(run.findings.find((f: { rule: string }) => f.rule === 'mass-assignment').title).toContain('isAdmin');
      expect(run.findings.find((f: { rule: string }) => f.rule === 'injection').evidence.response).toContain('SQL syntax');
      expect(JSON.stringify(run)).not.toContain('super-secret-token');
      expect(run.requests).toBeGreaterThan(20);
      const stored = await call(h, h.users.viewer, 'GET', `${sec()}/findings`);
      expect(stored.body.length).toBe(run.findings.length);
      expect(stored.body[0].severity).toBe('high');
    });

    it('marks a finding fixed when a rerun no longer finds it, and honours a suppression', async () => {
      const before = (await call(h, h.users.tester, 'GET', `${sec()}/findings`)).body;
      const injection = before.find((f: { rule: string }) => f.rule === 'injection');
      const cors = before.find((f: { rule: string }) => f.rule === 'cors-origin');
      expect((await call(h, h.users.tester, 'POST', `${sec()}/findings/${cors.id}/suppress`, { reason: 'x' })).status).toBe(400);
      const sup = await call(h, h.users.tester, 'POST', `${sec()}/findings/${cors.id}/suppress`, { reason: 'Accepted: public data only', days: 30 });
      expect(sup.body).toMatchObject({ status: 'suppressed', suppressReason: 'Accepted: public data only' });
      vulnFixed = true;
      const run = await finish((await call(h, h.users.tester, 'POST', `${sec()}/runs`, runBody())).body.id);
      expect(run.findings.some((f: { rule: string }) => f.rule === 'injection')).toBe(false);
      const after = (await call(h, h.users.tester, 'GET', `${sec()}/findings`)).body;
      expect(after.find((f: { id: string }) => f.id === injection.id).status).toBe('fixed');
      expect(after.find((f: { id: string }) => f.id === cors.id).status).toBe('suppressed');
      expect((await call(h, h.users.tester, 'POST', `${sec()}/findings/${cors.id}/reopen`)).body.status).toBe('open');
    });

    it('files a Jira bug from a finding, and keeps the checks away from viewers and other organisations', async () => {
      await call(h, h.users.tester, 'PUT', '/me/jira', { siteUrl: JIRA_SANDBOX.siteUrl, email: h.users.tester.email, apiToken: JIRA_SANDBOX.apiToken });
      const f = (await call(h, h.users.tester, 'GET', `${sec()}/findings`)).body[0];
      const bug = await call(h, h.users.tester, 'POST', `${sec()}/findings/${f.id}/bug`, { note: 'Found by the weekly check' });
      expect(bug.status).toBe(201);
      expect(bug.body.summary).toMatch(/^\[Security\]/);
      expect((await call(h, h.users.viewer, 'POST', `${sec()}/runs`, runBody())).status).toBe(403);
      expect((await call(h, h.users.outsider, 'GET', `${sec()}/findings`)).status).toBe(404);
    });
  });

  describe('WebSocket and SSE requests', () => {
    const sb = () => `${base()}/workspaces/${ws.id}/stream`;
    let wsEnv: ApiEnvironment;
    const def = (over: object) => ({ method: 'GET', url: '', auth: { type: 'none' }, ...over });
    const wsUrl = () => targetUrl.replace(/^http/, 'ws');

    it('talks to a WebSocket, sends messages with variables, checks the replies and masks secrets', async () => {
      wsEnv = (await call<ApiEnvironment>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/environments`, { name: 'stream-env', variables: [{ key: 'room', value: 'lobby' }, { key: 'token', value: 'ws-secret-token', secret: true }] })).body;
      const res = await call(h, h.users.tester, 'POST', sb(), {
        request: def({
          protocol: 'ws',
          url: `${wsUrl()}/chat`,
          auth: { type: 'bearer', token: '{{token}}' },
          stream: { send: ['join {{room}}'], listenMs: 3000, maxMessages: 2 },
          assertions: [
            { id: 'a', source: 'status', path: '', op: 'eq', value: '101', enabled: true },
            { id: 'b', source: 'body', path: '$[0].type', op: 'eq', value: 'welcome', enabled: true },
            { id: 'c', source: 'body', path: '$[1].text', op: 'eq', value: 'join lobby', enabled: true },
          ],
          extractors: [{ variable: 'reply', source: 'body', path: '$[1].text', enabled: true }],
        }),
        environmentId: wsEnv.id,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ protocol: 'ws', status: 101, endedBy: 'messages', extracted: { reply: 'join lobby' } });
      expect(res.body.url).toBe(`${wsUrl()}/chat`);
      expect(res.body.assertions.map((a: { passed: boolean }) => a.passed)).toEqual([true, true, true]);
      expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(['open', 'out', 'in', 'in']);
      expect(JSON.stringify(res.body)).not.toContain('ws-secret-token');
      expect(res.body.events[2].data).toContain('Bearer ••••');
    }, 15_000);

    it('reads Server-Sent Events', async () => {
      const res = await call(h, h.users.tester, 'POST', sb(), {
        request: def({ protocol: 'sse', url: `${targetUrl}/live/events`, auth: { type: 'bearer', token: '{{token}}' }, stream: { send: [], listenMs: 3000, maxMessages: 10 }, assertions: [{ id: 'a', source: 'body', path: '$[1].ok', op: 'eq', value: 'true', enabled: true }] }),
        environmentId: wsEnv.id,
      });
      expect(res.body).toMatchObject({ protocol: 'sse', status: 200, endedBy: 'server' });
      expect(res.body.events.filter((e: { kind: string }) => e.kind === 'in').map((e: { event: string }) => e.event)).toEqual(['hello', 'bye']);
      expect(res.body.assertions[0].passed).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('ws-secret-token');
    });

    it('says what went wrong instead of failing: a wrong scheme, a refused connection, a script error', async () => {
      const wrong = await call(h, h.users.tester, 'POST', sb(), { request: def({ protocol: 'ws', url: `${targetUrl}/chat` }) });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.message).toMatch(/ws:\/\//);
      const refused = await call(h, h.users.tester, 'POST', sb(), { request: def({ protocol: 'ws', url: 'ws://127.0.0.1:1/' }) });
      expect(refused.body.error.code).toBe('refused');
      const http = await call(h, h.users.tester, 'POST', sb(), { request: def({ url: `${targetUrl}/ping` }) });
      expect(http.status).toBe(400);
      const script = await call(h, h.users.tester, 'POST', sb(), { request: def({ protocol: 'ws', url: `${wsUrl()}/x`, scripts: { pre: 'throw new Error("nope")', post: '' } }) });
      expect(script.body.error.code).toBe('script');
    });

    it('is kept for testers, and a stream request is not run by the HTTP engines', async () => {
      expect((await call(h, h.users.viewer, 'POST', sb(), { request: def({ protocol: 'ws', url: `${wsUrl()}/x` }) })).status).toBe(403);
      const sent = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: def({ protocol: 'ws', url: `${wsUrl()}/x` }) });
      expect(sent.body.error.code).toBe('protocol');
    });
  });

  describe('load tests', () => {
    const lb = () => `${base()}/workspaces/${ws.id}/load-tests`;
    let good: ApiEnvironment;
    let searchId: string;
    let testId: string;
    const body = (over: object = {}) => ({
      name: 'Search under load',
      source: [{ kind: 'request', requestId: searchId, variationId: null }],
      environmentId: good.id,
      profile: 'smoke',
      vus: 2,
      seconds: 5,
      thresholds: { p95Ms: 5000, errorPercent: 1, minRps: null },
      ...over,
    });
    const finish = async (id: string, runId: string) => {
      for (let i = 0; i < 160; i++) {
        const r = await call(h, h.users.tester, 'GET', `${lb()}/${id}/runs/${runId}`);
        if (r.body.status !== 'running') return r.body;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      throw new Error('load run did not finish');
    };

    it('saves a test and lists it, for testers only', async () => {
      const tree = (await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`)).body;
      searchId = tree.find((n: { name: string }) => n.name === 'Search').id;
      good = (await call<ApiEnvironment>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/environments`, { name: 'load-env', variables: [{ key: 'baseUrl', value: targetUrl }, { key: 'token', value: 'super-secret-token', secret: true }] })).body;
      const saved = await call(h, h.users.tester, 'POST', lb(), body());
      expect(saved.status).toBe(201);
      testId = saved.body.id;
      expect(saved.body.lastRun).toBeNull();
      expect((await call(h, h.users.tester, 'POST', lb(), body())).status).toBe(409);
      expect((await call(h, h.users.viewer, 'POST', lb(), body({ name: 'x' }))).status).toBe(403);
      expect((await call(h, h.users.viewer, 'GET', lb())).body.map((t: { name: string }) => t.name)).toContain('Search under load');
      expect((await call(h, h.users.tester, 'POST', lb(), body({ name: 'empty', source: [{ kind: 'request', requestId: crypto.randomUUID(), variationId: null }] }))).status).toBe(400);
    });

    it('runs a smoke test, measures it, audits it and compares with the run before', async () => {
      const started = await call(h, h.users.tester, 'POST', `${lb()}/${testId}/runs`, {});
      expect(started.status).toBe(201);
      const run = await finish(testId, started.body.id);
      expect(run.status).toBe('passed');
      expect(run.metrics.requests).toBeGreaterThan(10);
      expect(run.metrics.errors).toBe(0);
      expect(run.metrics.endpoints.map((e: { name: string }) => e.name)).toEqual(['Search']);
      expect(run.metrics.timeline.length).toBeGreaterThanOrEqual(4);
      expect(run.verdicts.every((v: { passed: boolean }) => v.passed)).toBe(true);
      expect(run.compare).toBeNull();
      expect(JSON.stringify(run)).not.toContain('super-secret-token');
      const audit = await h.owner.selectFrom('outbox.event').select('data').where('org_id', '=', h.orgId).where('type', '=', 'apitest.load.run').execute();
      expect(audit.some((e) => (e.data as { profile?: string }).profile === 'smoke')).toBe(true);

      const again = await finish(testId, (await call(h, h.users.tester, 'POST', `${lb()}/${testId}/runs`, {})).body.id);
      expect(again.compare).toMatchObject({ previousId: run.id });
      expect((await call(h, h.users.viewer, 'GET', `${lb()}/${testId}`)).body.lastRun).toMatchObject({ id: again.id, status: 'passed' });
      expect((await call(h, h.users.viewer, 'GET', `${lb()}/${testId}/runs`)).body).toHaveLength(2);
    }, 40_000);

    it('runs a workflow as real flows, passing values between steps, and reports each step and the whole', async () => {
      const t = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Item lifecycle', source: [{ kind: 'workflow', workflowId: secWorkflowId }], seconds: 6 }));
      expect(t.status).toBe(201);
      const run = await finish(t.body.id, (await call(h, h.users.tester, 'POST', `${lb()}/${t.body.id}/runs`, {})).body.id);
      expect(run.status).toBe('passed');
      const steps = run.metrics.endpoints.filter((e: { name: string }) => e.name.includes('›')).map((e: { name: string }) => e.name.split('›')[1]!.trim()).sort();
      // "Get item" appears twice (the read back, and the one that expects the 404 after the delete), and so does
      // "Delete item" (the step, and the cleanup variation in the teardown).
      expect(steps).toEqual(['Create item', 'Delete item', 'Delete item', 'Get item', 'Get item', 'Log in']);
      // Every step succeeded, including the one that expects a 404 after the delete: values reached each step.
      expect(run.metrics.errors).toBe(0);
      const whole = run.metrics.endpoints.find((e: { name: string }) => e.name.endsWith('(whole workflow)'));
      expect(whole.requests).toBeGreaterThan(3);
      expect(whole.errors).toBe(0);
      expect(run.metrics.requests).toBeGreaterThan(whole.requests * 4);
      expect(JSON.stringify(run)).not.toContain('sec-token');
    }, 40_000);

    it('fails a run that misses a threshold, and stops one that is mostly failing', async () => {
      const t = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Too ambitious', thresholds: { p95Ms: 5000, errorPercent: 1, minRps: 100_000 } }));
      const missed = await finish(t.body.id, (await call(h, h.users.tester, 'POST', `${lb()}/${t.body.id}/runs`, {})).body.id);
      expect(missed.status).toBe('failed');
      expect(missed.verdicts.find((v: { name: string }) => v.name.includes('requests/s')).passed).toBe(false);

      const bad = (await call<ApiEnvironment>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/environments`, { name: 'bad-token', variables: [{ key: 'baseUrl', value: targetUrl }, { key: 'token', value: 'wrong', secret: true }] })).body;
      const f = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Rejected', environmentId: bad.id, seconds: 30 }));
      const stopped = await finish(f.body.id, (await call(h, h.users.tester, 'POST', `${lb()}/${f.body.id}/runs`, {})).body.id);
      expect(stopped.status).toBe('aborted');
      expect(stopped.error).toMatch(/Stopped early/);
      expect(stopped.metrics.errorPercent).toBeGreaterThan(50);
      expect(Date.parse(stopped.finishedAt) - Date.parse(stopped.startedAt)).toBeLessThan(15_000);
    }, 60_000);

    it('can be cancelled, and refuses more than it can run itself', async () => {
      const t = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Long', seconds: 120 }));
      const started = await call(h, h.users.tester, 'POST', `${lb()}/${t.body.id}/runs`, {});
      await new Promise((ok) => setTimeout(ok, 1000));
      await call(h, h.users.tester, 'POST', `${lb()}/${t.body.id}/runs/${started.body.id}/cancel`);
      expect((await finish(t.body.id, started.body.id)).status).toBe('cancelled');

      const big = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Huge', vus: 500, seconds: 60 }));
      expect(big.status).toBe(201);
      const refused = await call(h, h.users.tester, 'POST', `${lb()}/${big.body.id}/runs`, {});
      expect(refused.status).toBe(422);
      expect(refused.body.error.message).toMatch(/k6/);
    }, 40_000);

    it('guards production like the security checks do', async () => {
      const prod = (await call<ApiEnvironment>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/environments`, { name: 'live', production: true, variables: [{ key: 'baseUrl', value: targetUrl }, { key: 'token', value: 'super-secret-token', secret: true }] })).body;
      const t = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Against live', environmentId: prod.id }));
      const denied = await call(h, h.users.tester, 'POST', `${lb()}/${t.body.id}/runs`, {});
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('production_guard');
      const admin = await call(h, h.users.admin, 'POST', `${lb()}/${t.body.id}/runs`, { productionOverride: true });
      expect(admin.status).toBe(201);
      await call(h, h.users.admin, 'POST', `${lb()}/${t.body.id}/runs/${admin.body.id}/cancel`);
      await finish(t.body.id, admin.body.id);
    }, 30_000);

    it('exports a k6 script that carries no secret', async () => {
      const t = await call(h, h.users.tester, 'POST', lb(), body({ name: 'Exported', profile: 'load', vus: 500, seconds: 600 }));
      const res = await h.app.inject({ method: 'GET', url: `/api/v1${lb()}/${t.body.id}/k6`, headers: { authorization: `Bearer ${h.users.tester.token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("{ duration: '120s', target: 500 }");
      expect(res.body).toContain('__ENV.TB_SECRET_0');
      expect(res.body).not.toContain('super-secret-token');
      expect(res.body).toContain("'p(95)<5000'");
    });
  });

  describe('the assistant', () => {
    const ab = () => `${base()}/assistant`;

    it('explains pasted routes: known ones from the specs, unknown ones as undocumented', async () => {
      const res = await call(h, h.users.viewer, 'POST', `${ab()}/explain`, { text: "GET /orders/:id\nrouter.post('/orders', create)\nGET /nowhere/{x}" });
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.routes.map((r: { key: string }) => [r.key, r]));
      expect(byKey['GET /orders/{orderId}']).toMatchObject({ known: true });
      // The orderId link of GET was rejected by a tester earlier in this file, and the assistant honours that.
      expect(byKey['GET /orders/{orderId}'].dependsOn.some((d: { param: string }) => d.param === 'orderId')).toBe(false);
      expect(byKey['POST /orders']).toMatchObject({ known: true, feeds: expect.arrayContaining(['PATCH /orders/{orderId}']) });
      expect(byKey['GET /orders/{orderId}'].whatToTest.join(' ')).toMatch(/unknown id gets 404/);
      expect(byKey['GET /nowhere/{x}']).toMatchObject({ known: false });
      expect(byKey['GET /nowhere/{x}'].gaps[0]).toMatch(/Undocumented/);
      expect(res.body.ai.status).toBe('off');
    });

    it('maps a requirement to a chain of documented calls and makes a workflow of it', async () => {
      const plan = await call(h, h.users.tester, 'POST', `${ab()}/plan`, { requirement: 'A customer can create an order and then read it back' });
      expect(plan.body.chains.length).toBeGreaterThan(0);
      expect(plan.body.ai.status).toBe('used');
      const chosen = plan.body.chains[plan.body.chosen];
      expect(chosen.steps.at(-1)).toMatch(/orders/);
      const gap = await call(h, h.users.tester, 'POST', `${ab()}/plan`, { requirement: 'Export the quarterly weather report to a spreadsheet' });
      expect(gap.body).toMatchObject({ chosen: null, chains: [] });
      expect(gap.body.gaps).toHaveLength(1);

      const wf = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/assistant/workflow`, { name: 'From the assistant', steps: chosen.steps });
      expect(wf.status).toBe(201);
      expect(wf.body.def.steps.length).toBe(chosen.steps.length);
      const invented = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/assistant/workflow`, { name: 'Invented', steps: ['GET /not/real'] });
      expect(invented.status).toBe(400);
    });

    it('explains a 401 from the last response and names only real operations', async () => {
      const denied = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: { method: 'GET', url: `${targetUrl}/secure`, auth: { type: 'bearer', token: 'nope' } } });
      expect(denied.body.response?.status).toBe(401);
      const ask = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/assistant/ask`, { question: 'Why does this return 401?', historyId: denied.body.historyId });
      expect(ask.status).toBe(200);
      expect(ask.body.answer).toMatch(/401/);
      expect(ask.body.ai.status).toBe('used');
      const known = (await call(h, h.users.tester, 'GET', `${base()}/map`)).body.operations.map((o: { key: string }) => o.key);
      for (const k of ask.body.operations) expect(known).toContain(k);
    });

    it('reads how a login hands out its credential, and falls back to rules without AI permission', async () => {
      const login = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: { method: 'POST', url: `${targetUrl}/auth/token`, auth: { type: 'none' } } });
      const found = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/assistant/detect-auth`, { historyId: login.body.historyId });
      expect(found.body).toMatchObject({ found: true, config: { extract: { source: 'body', path: '$.access_token' }, apply: { as: 'bearer' } } });
      const none = await call<SendResult>(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/send`, { request: { method: 'GET', url: `${targetUrl}/me`, auth: { type: 'none' } } });
      expect((await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/assistant/detect-auth`, { historyId: none.body.historyId })).body.found).toBe(false);

      // A viewer has no AI permission: the answer still comes, from the rules.
      const viewer = await call(h, h.users.viewer, 'POST', `${ab()}/plan`, { requirement: 'create an order' });
      expect(viewer.status).toBe(200);
      expect(viewer.body.ai).toMatchObject({ status: 'off' });
      expect(viewer.body.chains.length).toBeGreaterThan(0);
      expect((await call(h, h.users.outsider, 'POST', `${ab()}/plan`, { requirement: 'create an order' })).status).toBe(404);
    });
  });

  describe('spec library', () => {
    const v1 = `openapi: 3.0.3
info: { title: Orders, version: '1.0' }
servers: [{ url: 'https://api.orders.test' }]
paths:
  /orders:
    post: { tags: [orders], summary: Create order, responses: { '201': { description: ok }, '422': { description: bad } } }
  /orders/{id}:
    get: { tags: [orders], summary: Get order, parameters: [{ name: id, in: path, required: true }], responses: { '200': { description: ok } } }
`;
    let specId: string;

    it('makes a version per change, none for the same content, and flags breaking changes', async () => {
      const first = await call<SpecUploadResult>(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Orders API', content: v1 });
      expect(first.status).toBe(201);
      specId = first.body.spec.id;
      expect(first.body.spec).toMatchObject({ version: 1, operationCount: 2, format: 'openapi3' });

      const same = await call<SpecUploadResult>(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Orders API', content: v1 });
      expect(same.body.created).toBe(false);

      const v2 = v1.replace(", '422': { description: bad }", '');
      const second = await call<SpecUploadResult>(h, h.users.tester, 'POST', `${base()}/specs/${specId}/versions`, { content: v2 });
      expect(second.status).toBe(201);
      const detail = await call<ApiSpecDetail>(h, h.users.viewer, 'GET', `${base()}/specs/${specId}`);
      expect(detail.body.version).toBe(2);
      expect(detail.body.versions[0]!.diff).toMatchObject({ fromVersion: 1, breaking: 1 });
    });

    it('explains an invalid spec instead of storing it', async () => {
      const bad = await call(h, h.users.tester, 'POST', `${base()}/specs`, { name: 'Broken', content: '{"hello": 1}' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toMatch(/OpenAPI/);
    });

    it('imports operations into a collection with folders by tag and baseUrl from the spec', async () => {
      const res = await call(h, h.users.tester, 'POST', `${base()}/specs/${specId}/import`, { workspaceId: ws.id });
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(2);
      const tree = await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`);
      const imported = tree.body.filter((n: { parentId: string | null }) => n.parentId !== null);
      expect(imported.map((n: { name: string }) => n.name)).toEqual(expect.arrayContaining(['orders', 'Create order', 'Get order']));
      const col = await call<ApiNodeDetail>(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/nodes/${res.body.collectionId}`);
      expect(col.body.config?.variables).toEqual([expect.objectContaining({ key: 'baseUrl', value: 'https://api.orders.test' })]);
    });

    it('flags requests and workflows a new spec version touches, until reviewed', async () => {
      const v3 = `openapi: 3.0.3
info: { title: Orders, version: '3.0' }
servers: [{ url: 'https://api.orders.test' }]
paths:
  /orders:
    post: { tags: [orders], summary: Create order, parameters: [{ name: X-Tenant, in: header, required: true }], responses: { '201': { description: ok } } }
  /orders/{id}:
    get: { tags: [orders], summary: Get order, parameters: [{ name: id, in: path, required: true }], responses: { '200': { description: ok } } }
`;
      expect((await call(h, h.users.tester, 'POST', `${base()}/specs/${specId}/versions`, { content: v3 })).status).toBe(201);
      const tree = await call(h, h.users.tester, 'GET', `${base()}/workspaces/${ws.id}/tree`);
      const flagged = tree.body.filter((n: { needsReview: string | null }) => n.needsReview);
      const create = flagged.find((n: { name: string }) => n.name === 'Create order');
      expect(create.needsReview).toMatch(/^Breaking: header parameter X-Tenant/);
      expect(flagged.some((n: { name: string }) => n.name === 'Get order')).toBe(false);
      const impact = await call(h, h.users.viewer, 'GET', `${base()}/specs/${specId}/impact`);
      expect(impact.body.items.map((i: { name: string }) => i.name)).toContain('Create order');

      const reviewed = await call(h, h.users.tester, 'POST', `${base()}/workspaces/${ws.id}/nodes/${create.id}/reviewed`);
      expect(reviewed.body.needsReview).toBeNull();
      expect(reviewed.body.request.operation.version).toBe(3);
    });

    it('keeps the library read-only for viewers and invisible outside the organisation', async () => {
      expect((await call(h, h.users.viewer, 'POST', `${base()}/specs`, { name: 'x', content: v1 })).status).toBe(403);
      expect((await call(h, h.users.outsider, 'GET', `${base()}/specs/${specId}`)).status).toBe(404);
    });
  });
});

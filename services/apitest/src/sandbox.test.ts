import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runScripts, type ScriptInput } from './sandbox';

const input = (over: Partial<ScriptInput> = {}): ScriptInput => ({
  phase: 'pre',
  request: { method: 'POST', url: 'https://api.test/orders', headers: [], body: '{"qty":1}' },
  response: null,
  variables: { baseUrl: 'https://api.test', apiSecret: 's3cret' },
  environment: { baseUrl: 'https://api.test' },
  ...over,
});
const run = (code: string, over: Partial<ScriptInput> = {}) => runScripts([{ source: 'request', code }], input(over));

describe('pre-request scripts', () => {
  it('sets variables, edits the request and signs it with tb.crypto', async () => {
    const out = await run(`
      const ts = '1700000000';
      tb.variables.set('ts', ts);
      tb.request.headers.add({ key: 'X-Sig', value: tb.crypto.hmacSha256(tb.variables.get('apiSecret'), ts + tb.request.body.raw) });
      tb.request.url = tb.request.url + '?v=2';
      tb.request.body.raw = { qty: 2 };
    `);
    expect(out.errors).toEqual([]);
    expect(out.set).toEqual({ ts: '1700000000' });
    expect(out.request.url).toBe('https://api.test/orders?v=2');
    expect(out.request.body).toBe('{"qty":2}');
    expect(out.request.headers[0]).toEqual({ key: 'X-Sig', value: createHmac('sha256', 's3cret').update('1700000000{"qty":1}').digest('hex'), enabled: true });
  });

  it('runs outer scripts first and shares what they set', async () => {
    const out = await runScripts(
      [
        { source: 'collection Orders', code: "tb.variables.set('a', 'from collection')" },
        { source: 'request', code: "console.log('saw', tb.variables.get('a'))" },
      ],
      input(),
    );
    expect(out.logs).toEqual([{ phase: 'pre', level: 'log', text: 'saw from collection' }]);
  });

  it('writes pm.environment.set to session values, not the shared environment', async () => {
    const out = await run("pm.environment.set('token', 'abc'); pm.collectionVariables.set('n', 3)");
    expect(out.set).toEqual({ token: 'abc', n: '3' });
  });
});

describe('post-response scripts', () => {
  const response = { code: 201, status: 'Created', headers: [['Content-Type', 'application/json']] as [string, string][], body: '{"id":"ord_1","items":[1,2]}', responseTime: 120, size: 30 };

  it('records passing and failing tests with Postman syntax', async () => {
    const out = await run(
      `
      pm.test('created', () => pm.response.to.have.status(201));
      pm.test('has id', () => pm.expect(pm.response.json()).to.have.property('id', 'ord_1'));
      pm.test('two items', () => pm.expect(pm.response.json().items).to.have.lengthOf(3));
      tb.test('fast', () => tb.expect(tb.response.responseTime).to.be.below(800));
      pm.environment.set('orderId', pm.response.json().id);
    `,
      { phase: 'post', response },
    );
    expect(out.tests.map((t) => [t.name, t.passed])).toEqual([
      ['created', true],
      ['has id', true],
      ['two items', false],
      ['fast', true],
    ]);
    expect(out.tests[2]!.error).toContain('to have length 3');
    expect(out.set).toEqual({ orderId: 'ord_1' });
  });
});

describe('the sandbox', () => {
  it('stops a script that never ends', async () => {
    const started = Date.now();
    const out = await run("console.log('before'); while (true) {}");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.errors[0]!.message).toMatch(/longer than 1 s/);
    expect(out.logs[0]!.text).toBe('before');
  });

  it('stops a script that eats memory', async () => {
    const out = await run("const a = []; while (true) a.push('x'.repeat(1e5));");
    expect(out.errors).toHaveLength(1);
  });

  it('has no Node, network, files or process', async () => {
    const out = await run(`
      for (const name of ['process', 'require', 'fetch', 'XMLHttpRequest', 'Buffer', 'setTimeout']) {
        let reachable = false;
        try { reachable = typeof globalThis[name] !== 'undefined' && name !== 'require'; if (name === 'require') require('fs'); } catch (e) { console.log(name, 'blocked'); continue; }
        console.log(name, reachable ? 'REACHABLE' : 'absent');
      }
      try { console.log('process:', typeof Function('return process')()); } catch (e) { console.log('process: blocked'); }
    `);
    const text = out.logs.map((l) => l.text).join('\n');
    expect(text).not.toContain('REACHABLE');
    expect(text).toContain('require blocked');
    expect(out.logs.at(-1)!.text).toMatch(/^process: (undefined|blocked)$/);
  });

  it('reports a syntax error with where it came from, and says what pm features are missing', async () => {
    expect((await run('this is not js')).errors[0]).toMatchObject({ source: 'request' });
    expect((await run('pm.setNextRequest(null)')).errors[0]!.message).toContain('pm.setNextRequest is not supported');
  });

  it('does nothing when there are no scripts', async () => {
    expect(await runScripts([{ source: 'request', code: '  ' }], input())).toMatchObject({ set: {}, tests: [], errors: [] });
  });
});

describe('sendRequest', () => {
  const calls: { method: string; url: string; headers: [string, string][]; body: string | null }[] = [];
  const host = {
    send: async (req: (typeof calls)[number]) => {
      calls.push(req);
      await new Promise((r) => setTimeout(r, 1200)); // longer than the CPU budget: waiting must not count
      if (req.url.includes('fail')) return { error: 'refused' };
      return { code: 200, status: 'OK', headers: [['Content-Type', 'application/json']] as [string, string][], body: '{"token":"t-9"}', responseTime: 5, size: 15 };
    },
  };

  it('waits for the host and hands back the response, in tb and Postman style', async () => {
    const out = await runScripts(
      [
        {
          source: 'request',
          code: `
            const r = tb.sendRequest({ url: 'https://auth.test/token', method: 'post', header: [{ key: 'X-A', value: '1' }], body: { mode: 'raw', raw: 'x' } });
            tb.variables.set('token', r.json().token);
            pm.sendRequest('https://auth.test/fail', (err, res) => console.log('err', err && err.message, res));
          `,
        },
      ],
      input(),
      host,
    );
    expect(out.errors).toEqual([]);
    expect(out.set).toEqual({ token: 't-9' });
    expect(calls[0]).toEqual({ method: 'POST', url: 'https://auth.test/token', headers: [['X-A', '1']], body: 'x' });
    expect(out.logs[0]!.text).toBe('err refused null');
  });

  it('caps how many requests one run can send', async () => {
    const out = await runScripts([{ source: 'request', code: 'for (let i = 0; i < 7; i++) { try { tb.sendRequest("https://a.test/" + i); } catch (e) { console.log(e.message); } }' }], input(), {
      send: async () => ({ code: 200, status: 'OK', headers: [], body: '', responseTime: 1, size: 0 }),
    });
    expect(out.logs.map((l) => l.text)).toEqual(['A script run can send at most 5 requests.', 'A script run can send at most 5 requests.']);
  });

  it('says it is unavailable where no host is given', async () => {
    const out = await run("try { tb.sendRequest('https://a.test') } catch (e) { console.log(e.message) }");
    expect(out.logs[0]!.text).toContain('not available');
  });
});

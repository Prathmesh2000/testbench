import { describe, expect, it } from 'vitest';
import { fromCurl, shellWords } from './curl';
import { fromPostmanCollection, fromPostmanEnvironment, ImportError, toPostmanCollection } from './postman';
import { snippet } from './snippets';

const COLLECTION = {
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'baseUrl', value: 'https://api.shop.test' }, { key: 'bad key', value: 'x' }],
  event: [{ listen: 'prerequest', script: { exec: ["pm.variables.set('ts', Date.now());"] } }],
  item: [
    {
      name: 'Orders',
      auth: { type: 'noauth' },
      item: [
        {
          name: 'Get order',
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));', 'pm.setNextRequest(null);'] } }],
          request: {
            method: 'GET',
            header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Debug', value: '1', disabled: true }],
            url: { raw: '{{baseUrl}}/orders/:orderId?expand=items', query: [{ key: 'expand', value: 'items' }] },
          },
        },
        {
          name: 'Upload',
          request: { method: 'POST', url: '{{baseUrl}}/files', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: 'a.png' }, { key: 'note', value: 'hi', type: 'text' }] } },
        },
      ],
    },
    {
      name: 'Create order',
      request: {
        method: 'POST',
        url: '{{baseUrl}}/orders',
        auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
        body: { mode: 'raw', raw: '{"qty":1}', options: { raw: { language: 'json' } } },
      },
    },
  ],
};

describe('Postman import', () => {
  const out = fromPostmanCollection(COLLECTION);

  it('keeps the tree, auth, variables and scripts', () => {
    expect(out).toMatchObject({ name: 'Shop', requestCount: 3 });
    expect(out.config.auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(out.config.variables).toEqual([{ key: 'baseUrl', value: 'https://api.shop.test', secret: false, enabled: true }]);
    expect(out.config.scripts.pre).toContain('pm.variables.set');
    const [folder, create] = out.items;
    expect(folder).toMatchObject({ kind: 'folder', name: 'Orders', config: { auth: { type: 'none' } } });
    const get = folder!.children![0]!.request!;
    expect(get.url).toBe('{{baseUrl}}/orders/{{orderId}}');
    expect(get.params).toEqual([{ key: 'expand', value: 'items', enabled: true }]);
    expect(get.headers[1]).toMatchObject({ key: 'X-Debug', enabled: false });
    expect(get.auth).toEqual({ type: 'inherit' });
    expect(get.scripts.post).toContain('pm.test');
    // v2.0 style object params are read too.
    expect(create!.request!.auth).toEqual({ type: 'basic', username: 'u', password: 'p' });
    expect(create!.request!.body).toEqual({ type: 'json', text: '{"qty":1}' });
  });

  it('lists what did not carry over instead of dropping it silently', () => {
    expect(out.warnings.join('\n')).toMatch(/setNextRequest/);
    expect(out.warnings.join('\n')).toMatch(/Upload: file fields/);
  });

  it('refuses what is not a v2 collection', () => {
    expect(() => fromPostmanCollection({ hello: 1 })).toThrow(ImportError);
    expect(() => fromPostmanCollection({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/' }, item: [] })).toThrow(/v2.1/);
  });

  it('imports an environment, keeping Postman secrets secret', () => {
    const env = fromPostmanEnvironment({ name: 'qa', values: [{ key: 'host', value: 'qa.test', enabled: true }, { key: 'token', value: 't', type: 'secret', enabled: true }] });
    expect(env.variables[1]).toEqual({ key: 'token', value: 't', secret: true, enabled: true });
  });

  it('exports without secret values and imports back the same shape', () => {
    const exported = toPostmanCollection({
      kind: 'collection',
      name: 'Shop',
      config: { auth: { type: 'none' }, variables: [{ key: 'token', value: 'real', secret: true, enabled: true }], scripts: { pre: '', post: '' } },
      request: null,
      children: [{ kind: 'request', name: 'Create order', config: null, request: out.items[1]!.request!, children: [] }],
    });
    expect(JSON.stringify(exported)).not.toContain('real');
    const again = fromPostmanCollection(exported);
    expect(again.items[0]!.request).toMatchObject({ method: 'POST', url: '{{baseUrl}}/orders', body: { type: 'json', text: '{"qty":1}' } });
  });
});

describe('cURL import', () => {
  it('splits shell words with every quoting style', () => {
    expect(shellWords(`curl 'a b' "c \\"d\\"" e\\ f $'g\\nh' \\\n --x`)).toEqual(['curl', 'a b', 'c "d"', 'e f', 'g\nh', '--x']);
  });

  it('reads a Chrome "Copy as cURL" command', () => {
    const { request } = fromCurl(`curl 'https://api.shop.test/orders?page=2' \\
      -H 'accept: application/json' \\
      -H 'content-type: application/json' \\
      -b 'sid=abc' \\
      --data-raw '{"qty":2}' \\
      --compressed`);
    expect(request).toMatchObject({ method: 'POST', url: 'https://api.shop.test/orders', params: [{ key: 'page', value: '2' }], body: { type: 'json', text: '{"qty":2}' } });
    expect(request.headers).toContainEqual({ key: 'Cookie', value: 'sid=abc', enabled: true });
  });

  it('handles -X, -u, forms, -G and attached values', () => {
    expect(fromCurl('curl -XDELETE https://x.test/a -u me:pw').request).toMatchObject({ method: 'DELETE', auth: { type: 'basic', username: 'me', password: 'pw' } });
    expect(fromCurl("curl https://x.test/login -d 'user=a&pass=b c'").request.body).toEqual({ type: 'form', fields: [{ key: 'user', value: 'a', enabled: true }, { key: 'pass', value: 'b c', enabled: true }] });
    expect(fromCurl('curl -G https://x.test/s -d q=hi').request).toMatchObject({ method: 'GET', params: [{ key: 'q', value: 'hi' }], body: { type: 'none' } });
    expect(fromCurl('curl --header=X-A:1 --json {"a":1} x.test').request).toMatchObject({ url: 'https://x.test/', headers: [{ key: 'X-A', value: '1' }, { key: 'Content-Type', value: 'application/json' }] });
  });

  it('warns about what it cannot bring over, and rejects what is not curl', () => {
    expect(fromCurl('curl -k https://x.test -d @body.json').warnings).toHaveLength(2);
    expect(() => fromCurl('wget https://x.test')).toThrow(/starts with curl/);
    expect(() => fromCurl("curl 'https://x.test")).toThrow(/unclosed/);
  });
});

describe('snippets', () => {
  const r = { method: 'POST', url: "https://api.test/o?x=it's", headers: [['Content-Type', 'application/json']] as [string, string][], body: '{"a":"b\'c"}' };

  it('quotes safely for the shell', () => {
    const cmd = snippet('curl', r);
    expect(cmd).toContain(`'https://api.test/o?x=it'\\''s'`);
    // The snippet must survive a round trip through the importer.
    expect(fromCurl(cmd).request).toMatchObject({ method: 'POST', body: { type: 'json', text: '{"a":"b\'c"}' } });
  });

  it('writes each language with the method, URL, headers and body', () => {
    for (const lang of ['fetch', 'python', 'go', 'java', 'csharp'] as const) {
      const code = snippet(lang, r);
      expect(code, lang).toContain('POST');
      expect(code, lang).toContain("https://api.test/o?x=it's");
      expect(code, lang).toContain('b\'c');
    }
    expect(snippet('go', { ...r, body: null })).not.toContain('strings');
  });
});

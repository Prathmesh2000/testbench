import { ApiRequestDef } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { applyVariation, buildRequest, effectiveAuth, maskHeaders, maskSecrets, type Scopes } from './resolve';

const def = (over: Partial<ApiRequestDef> = {}) => ApiRequestDef.parse({ method: 'GET', url: '{{baseUrl}}/orders', ...over });
const v = (key: string, value: string, secret = false) => ({ key, value, secret, enabled: true });

describe('buildRequest', () => {
  it('lets the more specific scope win', () => {
    const scopes: Scopes = [[v('baseUrl', 'https://folder.test')], [v('baseUrl', 'https://env.test')]];
    expect(buildRequest(def(), { type: 'none' }, scopes).url).toBe('https://folder.test/orders');
  });

  it('resolves a variable that refers to another, and reports unknown ones', () => {
    const scopes: Scopes = [[v('baseUrl', 'https://{{host}}'), v('host', 'api.test')]];
    const req = buildRequest(def({ headers: [{ key: 'X-Trace', value: '{{trace}}', enabled: true }] }), { type: 'none' }, scopes);
    expect(req.url).toBe('https://api.test/orders');
    expect(req.headers).toContainEqual(['X-Trace', '{{trace}}']);
    expect(req.unresolved).toEqual(['trace']);
  });

  it('ignores disabled variables, params and headers', () => {
    const scopes: Scopes = [[{ ...v('baseUrl', 'https://off.test'), enabled: false }], [v('baseUrl', 'https://on.test')]];
    const req = buildRequest(
      def({
        params: [
          { key: 'page', value: '2', enabled: true },
          { key: 'debug', value: '1', enabled: false },
        ],
        headers: [{ key: 'X-Off', value: '1', enabled: false }],
      }),
      { type: 'none' },
      scopes,
    );
    expect(req.url).toBe('https://on.test/orders?page=2');
    expect(req.headers).toEqual([]);
  });

  it('refuses a URL with no scheme, naming an unknown variable when that is the cause', () => {
    expect(() => buildRequest(def(), { type: 'none' }, [])).toThrow(/unknown variable/);
    expect(() => buildRequest(def({ url: 'api.test/x' }), { type: 'none' }, [])).toThrow(/http:\/\//);
  });

  it('applies auth and records every secret it used', () => {
    const scopes: Scopes = [[v('baseUrl', 'https://api.test'), v('token', 'tok-123', true)]];
    const bearer = buildRequest(def(), { type: 'bearer', token: '{{token}}' }, scopes);
    expect(bearer.headers).toContainEqual(['Authorization', 'Bearer tok-123']);
    expect(bearer.secrets).toContain('tok-123');

    const basic = buildRequest(def(), { type: 'basic', username: 'u', password: 'p4ss' }, scopes);
    expect(basic.headers).toContainEqual(['Authorization', `Basic ${Buffer.from('u:p4ss').toString('base64')}`]);
    expect(basic.secrets).toContain('p4ss');

    const query = buildRequest(def(), { type: 'apikey', key: 'api_key', value: 'k9', in: 'query' }, scopes);
    expect(query.url).toBe('https://api.test/orders?api_key=k9');
  });

  it('sets the content type for each body kind unless one is given', () => {
    const scopes: Scopes = [[v('baseUrl', 'https://api.test'), v('qty', '2')]];
    const json = buildRequest(def({ method: 'POST', body: { type: 'json', text: '{"qty": {{qty}}}' } }), { type: 'none' }, scopes);
    expect(json.body?.toString()).toBe('{"qty": 2}');
    expect(json.headers).toContainEqual(['Content-Type', 'application/json']);

    const own = buildRequest(
      def({ method: 'POST', headers: [{ key: 'content-type', value: 'application/vnd.x+json', enabled: true }], body: { type: 'json', text: '{}' } }),
      { type: 'none' },
      scopes,
    );
    expect(own.headers.filter(([k]) => k.toLowerCase() === 'content-type')).toHaveLength(1);

    const form = buildRequest(def({ method: 'POST', body: { type: 'form', fields: [{ key: 'a b', value: 'c&d', enabled: true }] } }), { type: 'none' }, scopes);
    expect(form.body?.toString()).toBe('a+b=c%26d');

    const gql = buildRequest(def({ method: 'POST', body: { type: 'graphql', query: '{ me { id } }', variables: '' } }), { type: 'none' }, scopes);
    expect(JSON.parse(gql.body!.toString())).toEqual({ query: '{ me { id } }' });
    expect(() => buildRequest(def({ method: 'POST', body: { type: 'graphql', query: 'q', variables: '{bad' } }), { type: 'none' }, scopes)).toThrow(/GraphQL/);
  });

  it('fills dynamic variables fresh on every use', () => {
    const req = buildRequest(def({ url: 'https://api.test/{{$uuid}}/{{$uuid}}' }), { type: 'none' }, []);
    const [a, b] = new URL(req.url).pathname.split('/').filter(Boolean);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('stops a variable that refers to itself', () => {
    const req = buildRequest(def({ url: 'https://api.test/{{loop}}' }), { type: 'none' }, [[v('loop', '{{loop}}')]]);
    expect(req.url).toContain('https://api.test/');
  });
});

describe('effectiveAuth and applyVariation', () => {
  it('inherits from the nearest folder or collection that sets auth', () => {
    const token = { type: 'bearer', token: 't' } as const;
    expect(effectiveAuth({ type: 'inherit' }, [{ type: 'inherit' }, token])).toEqual(token);
    expect(effectiveAuth({ type: 'inherit' }, [])).toEqual({ type: 'none' });
    expect(effectiveAuth({ type: 'none' }, [token])).toEqual({ type: 'none' });
  });

  it('replaces only the fields a variation sets', () => {
    const base = def({ headers: [{ key: 'A', value: '1', enabled: true }], body: { type: 'json', text: '{"qty":1}' } });
    const out = applyVariation(base, { body: { type: 'json', text: '{"qty":0}' } });
    expect(out.body).toEqual({ type: 'json', text: '{"qty":0}' });
    expect(out.headers).toEqual(base.headers);
  });
});

describe('masking', () => {
  it('masks the longest secret first', () => {
    expect(maskSecrets('abc and abcdef', ['abc', 'abcdef'])).toBe('•••••• and ••••••');
  });

  it('cuts credential headers to their scheme even when not a secret variable', () => {
    expect(
      maskHeaders(
        [
          ['Authorization', 'Bearer plain-typed'],
          ['Cookie', 'sid=1; theme=dark'],
          ['X-Other', 'has tok-1 inside'],
        ],
        ['tok-1'],
      ),
    ).toEqual([
      ['Authorization', 'Bearer ••••••'],
      ['Cookie', 'sid=••••••; theme=••••••'],
      ['X-Other', 'has •••••• inside'],
    ]);
  });
});

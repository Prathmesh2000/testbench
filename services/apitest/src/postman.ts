import { ApiRequestDef, HTTP_METHODS, type ApiAuth, type ApiBody, type ApiContainerConfig, type ApiVariable, type HttpMethod, type KeyValue } from '@tb/contracts';

// Postman collections (v2.0 and v2.1) and environments in and out (plan §4). Import keeps what maps
// cleanly and lists what does not, so nothing is dropped silently; export never includes secret values.

export class ImportError extends Error {}

export interface ImportedItem {
  kind: 'folder' | 'request';
  name: string;
  config?: ApiContainerConfig;
  request?: ApiRequestDef;
  children?: ImportedItem[];
}

export interface ImportedCollection {
  name: string;
  config: ApiContainerConfig;
  items: ImportedItem[];
  warnings: string[];
  requestCount: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// Script calls the sandbox does not have yet; a script that uses one imports, with a warning.
const UNSUPPORTED: [RegExp, string][] = [
  [/pm\.setNextRequest|postman\.setNextRequest/, 'setNextRequest'],
  [/pm\.cookies/, 'pm.cookies'],
  [/pm\.execution/, 'pm.execution'],
  [/pm\.visualizer/, 'pm.visualizer'],
  [/pm\.vault/, 'pm.vault'],
  [/\brequire\s*\(/, 'require()'],
];

/** Postman's :id path segments become {{id}}, the syntax the rest of Testbench uses. */
const pathVars = (url: string) => url.replace(/(^|\/):([A-Za-z_][\w-]*)/g, '$1{{$2}}');

function kv(list: unknown): KeyValue[] {
  return arr(list)
    .filter(isObj)
    .map((h) => ({ key: str(h.key).slice(0, 500), value: str(h.value).slice(0, 10_000), enabled: h.disabled !== true }));
}

/** Auth params come as [{key, value}] in v2.1 and as a plain object in v2.0. */
function authParam(block: unknown, key: string): string {
  if (Array.isArray(block)) return str((block.find((p) => isObj(p) && p.key === key) as Obj | undefined)?.value);
  return isObj(block) ? str(block[key]) : '';
}

function auth(raw: unknown, where: string, warnings: string[]): ApiAuth | undefined {
  if (!isObj(raw)) return undefined;
  const type = str(raw.type);
  const block = raw[type];
  if (type === 'noauth') return { type: 'none' };
  if (type === 'bearer') return { type: 'bearer', token: authParam(block, 'token') };
  if (type === 'basic') return { type: 'basic', username: authParam(block, 'username'), password: authParam(block, 'password') };
  if (type === 'apikey')
    return { type: 'apikey', key: authParam(block, 'key') || 'X-API-Key', value: authParam(block, 'value'), in: authParam(block, 'in') === 'query' ? 'query' : 'header' };
  warnings.push(`${where}: ${type} auth is not supported yet and was left out; set it up again in Testbench.`);
  return undefined;
}

function body(raw: unknown, where: string, warnings: string[]): ApiBody {
  if (!isObj(raw)) return { type: 'none' };
  const mode = str(raw.mode);
  if (mode === 'raw') {
    const text = str(raw.raw);
    const lang = isObj(raw.options) && isObj(raw.options.raw) ? str(raw.options.raw.language) : '';
    if (lang === 'json' || (!lang && /^\s*[{[]/.test(text))) return { type: 'json', text };
    const types: Record<string, string> = { xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };
    return { type: 'text', text, contentType: types[lang] ?? 'text/plain' };
  }
  if (mode === 'urlencoded') return { type: 'form', fields: kv(raw.urlencoded) };
  if (mode === 'formdata') {
    const fields = arr(raw.formdata).filter(isObj);
    if (fields.some((f) => f.type === 'file')) warnings.push(`${where}: file fields in form data are not supported yet and were left out.`);
    warnings.push(`${where}: multipart form data is sent as a URL-encoded form for now.`);
    return { type: 'form', fields: kv(fields.filter((f) => f.type !== 'file')) };
  }
  if (mode === 'graphql' && isObj(raw.graphql)) return { type: 'graphql', query: str(raw.graphql.query), variables: str(raw.graphql.variables) };
  if (mode === 'file') warnings.push(`${where}: a file body is not supported yet and was left out.`);
  return { type: 'none' };
}

function url(raw: unknown): { url: string; params: KeyValue[] } {
  if (typeof raw === 'string') return { url: pathVars(raw), params: [] };
  if (!isObj(raw)) return { url: '', params: [] };
  const query = kv(raw.query);
  // raw includes the query string; the params table owns it after import, so it is cut from the URL.
  const full = str(raw.raw) || [arr(raw.host).map(str).join('.'), arr(raw.path).map(str).join('/')].filter(Boolean).join('/');
  return { url: pathVars(query.length ? full.split('?')[0]! : full), params: query };
}

function scripts(events: unknown, where: string, warnings: string[]): { pre: string; post: string } {
  const out = { pre: '', post: '' };
  for (const e of arr(events).filter(isObj)) {
    const script = isObj(e.script) ? e.script : {};
    const code = Array.isArray(script.exec) ? script.exec.map(str).join('\n') : str(script.exec);
    if (!code.trim()) continue;
    const listen = str(e.listen);
    if (listen === 'prerequest') out.pre = code;
    else if (listen === 'test') out.post = code;
    const missing = UNSUPPORTED.filter(([re]) => re.test(code)).map(([, label]) => label);
    if (missing.length) warnings.push(`${where}: its script uses ${missing.join(', ')}, which Testbench scripts do not support yet; that part will fail when run.`);
  }
  return out;
}

function variables(list: unknown): ApiVariable[] {
  const seen = new Set<string>();
  return arr(list)
    .filter(isObj)
    .map((v) => ({ key: str(v.key).trim(), value: str(v.value), secret: false, enabled: v.disabled !== true }))
    .filter((v) => /^[A-Za-z_][\w.-]*$/.test(v.key) && !seen.has(v.key) && seen.add(v.key));
}

function convertItems(list: unknown, path: string, warnings: string[], counter: { n: number }): ImportedItem[] {
  const out: ImportedItem[] = [];
  for (const item of arr(list).filter(isObj)) {
    const name = (str(item.name) || 'Untitled').slice(0, 200);
    const where = `${path}${name}`;
    if (Array.isArray(item.item)) {
      out.push({
        kind: 'folder',
        name,
        config: { auth: auth(item.auth, where, warnings) ?? { type: 'inherit' }, variables: variables(item.variable), scripts: scripts(item.event, where, warnings) },
        children: convertItems(item.item, `${where} / `, warnings, counter),
      });
      continue;
    }
    const req = isObj(item.request) ? item.request : typeof item.request === 'string' ? { url: item.request } : null;
    if (!req) continue;
    counter.n++;
    const method = str(req.method).toUpperCase() || 'GET';
    if (!(HTTP_METHODS as readonly string[]).includes(method)) warnings.push(`${where}: method ${method} is not supported and was sent as GET.`);
    const u = url(req.url);
    out.push({
      kind: 'request',
      name,
      request: ApiRequestDef.parse({
        method: (HTTP_METHODS as readonly string[]).includes(method) ? (method as HttpMethod) : 'GET',
        url: u.url.slice(0, 8000),
        params: u.params,
        headers: kv(req.header),
        body: body(req.body, where, warnings),
        auth: auth(req.auth, where, warnings) ?? { type: 'inherit' },
        docs: str(isObj(req.description) ? req.description.content : req.description).slice(0, 20_000),
        scripts: scripts(item.event, where, warnings),
      }),
    });
  }
  return out;
}

/** A Postman collection export (v2.0 or v2.1) as a tree ready to write into a workspace. */
export function fromPostmanCollection(doc: unknown): ImportedCollection {
  if (!isObj(doc) || !isObj(doc.info) || !Array.isArray(doc.item))
    throw new ImportError('This is not a Postman collection: it needs "info" and "item". Export it from Postman as Collection v2.1.');
  const schema = str(doc.info.schema);
  if (schema && !/v2\.[01]/.test(schema)) throw new ImportError('Only Postman collection v2.0 and v2.1 can be imported. Re-export the collection as v2.1.');
  const warnings: string[] = [];
  const counter = { n: 0 };
  const name = (str(doc.info.name) || 'Imported collection').slice(0, 200);
  const items = convertItems(doc.item, '', warnings, counter);
  return {
    name,
    config: { auth: auth(doc.auth, name, warnings) ?? { type: 'none' }, variables: variables(doc.variable), scripts: scripts(doc.event, name, warnings) },
    items,
    warnings,
    requestCount: counter.n,
  };
}

/** A Postman environment export. Postman's "secret" values stay secret here. */
export function fromPostmanEnvironment(doc: unknown): { name: string; variables: ApiVariable[] } {
  if (!isObj(doc) || !Array.isArray(doc.values)) throw new ImportError('This is not a Postman environment: it needs "values".');
  const seen = new Set<string>();
  return {
    name: (str(doc.name) || 'Imported').slice(0, 60),
    variables: doc.values
      .filter(isObj)
      .map((v) => ({ key: str(v.key).trim(), value: str(v.value), secret: v.type === 'secret', enabled: v.enabled !== false }))
      .filter((v) => /^[A-Za-z_][\w.-]*$/.test(v.key) && !seen.has(v.key) && seen.add(v.key)),
  };
}

// ---------- export ----------

export interface ExportNode {
  kind: 'collection' | 'folder' | 'request';
  name: string;
  config: ApiContainerConfig | null;
  request: ApiRequestDef | null;
  children: ExportNode[];
}

function authOut(a: ApiAuth): Obj | undefined {
  if (a.type === 'inherit') return undefined;
  if (a.type === 'none') return { type: 'noauth' };
  if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.token, type: 'string' }] };
  if (a.type === 'basic') return { type: 'basic', basic: [{ key: 'username', value: a.username }, { key: 'password', value: a.password }] };
  // Postman has nothing like an auth profile; its login request is in the export and can be run first.
  if (a.type === 'profile') return undefined;
  return { type: 'apikey', apikey: [{ key: 'key', value: a.key }, { key: 'value', value: a.value }, { key: 'in', value: a.in }] };
}

function eventsOut(s: { pre: string; post: string }): Obj[] | undefined {
  const out = [
    s.pre.trim() && { listen: 'prerequest', script: { type: 'text/javascript', exec: s.pre.split('\n') } },
    s.post.trim() && { listen: 'test', script: { type: 'text/javascript', exec: s.post.split('\n') } },
  ].filter(Boolean) as Obj[];
  return out.length ? out : undefined;
}

function bodyOut(b: ApiBody): Obj | undefined {
  if (b.type === 'json') return { mode: 'raw', raw: b.text, options: { raw: { language: 'json' } } };
  if (b.type === 'text') return { mode: 'raw', raw: b.text, options: { raw: { language: 'text' } } };
  if (b.type === 'form') return { mode: 'urlencoded', urlencoded: b.fields.map((f) => ({ key: f.key, value: f.value, disabled: !f.enabled || undefined })) };
  if (b.type === 'graphql') return { mode: 'graphql', graphql: { query: b.query, variables: b.variables } };
  return undefined;
}

/** Secret variables export with an empty value: the file may be shared, the secret must not be. */
const varsOut = (vs: ApiVariable[]) => vs.map((v) => ({ key: v.key, value: v.secret ? '' : v.value, disabled: !v.enabled || undefined }));

function itemOut(n: ExportNode): Obj {
  if (n.kind === 'request' && n.request) {
    const r = n.request;
    const query = r.params.map((p) => ({ key: p.key, value: p.value, disabled: !p.enabled || undefined }));
    const enabledQuery = r.params.filter((p) => p.enabled).map((p) => `${p.key}=${p.value}`).join('&');
    return {
      name: n.name,
      event: eventsOut(r.scripts),
      request: {
        method: r.method,
        header: r.headers.map((h) => ({ key: h.key, value: h.value, disabled: !h.enabled || undefined })),
        body: bodyOut(r.body),
        auth: authOut(r.auth),
        url: { raw: enabledQuery ? `${r.url}?${enabledQuery}` : r.url, query: query.length ? query : undefined },
        description: r.docs || undefined,
      },
    };
  }
  return {
    name: n.name,
    item: n.children.map(itemOut),
    auth: n.config ? authOut(n.config.auth) : undefined,
    variable: n.config?.variables.length ? varsOut(n.config.variables) : undefined,
    event: n.config ? eventsOut(n.config.scripts) : undefined,
  };
}

/** A collection or folder as a Postman v2.1 collection. */
export function toPostmanCollection(root: ExportNode): Obj {
  const top = itemOut(root);
  return {
    info: { name: root.name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: top.item ?? [top],
    auth: top.auth,
    variable: top.variable,
    event: top.event,
  };
}

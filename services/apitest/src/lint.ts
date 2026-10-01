import type { LintIssue, LintReport, LintRule } from '@tb/contracts';
import { deref, readSpec } from './spec';

// The spec quality check (plan §10): rules over an OpenAPI or Swagger document, each finding with a
// JSON pointer, the operation it is about, why it matters and how to fix it. Pure, so every rule is
// tested on its own; a project can switch rules off with a reason.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const ptr = (...parts: (string | number)[]) => `#/${parts.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

export const RULES: LintRule[] = [
  { id: 'security-defined', category: 'security', severity: 'error', title: 'Security is declared', why: 'Without it nobody can tell which operations need a credential, so auth tests cannot be generated.' },
  { id: 'sensitive-in-url', category: 'security', severity: 'error', title: 'No secrets in URLs', why: 'URLs end up in logs, proxies and browser history.' },
  { id: 'apikey-in-query', category: 'security', severity: 'warning', title: 'API keys go in headers', why: 'A key in the query string is logged wherever the URL is.' },
  { id: 'password-write-only', category: 'security', severity: 'warning', title: 'Passwords are write-only', why: 'A password field that can be returned is a data leak waiting to happen.' },
  { id: 'op-success-response', category: 'completeness', severity: 'error', title: 'Every operation documents a 2xx', why: 'There is no expected result to test against.' },
  { id: 'op-error-response', category: 'completeness', severity: 'warning', title: 'Every operation documents an error', why: 'Negative tests need to know what a failure looks like.' },
  { id: 'op-response-schema', category: 'completeness', severity: 'warning', title: 'Success responses have a schema', why: 'Without one, responses cannot be checked for drift.' },
  { id: 'op-summary', category: 'completeness', severity: 'warning', title: 'Every operation has a summary', why: 'Summaries name the generated requests and tests.' },
  { id: 'op-operation-id', category: 'completeness', severity: 'warning', title: 'Every operation has an operationId', why: 'Links, SDKs and test mappings refer to operations by id.' },
  { id: 'op-examples', category: 'completeness', severity: 'info', title: 'Bodies have examples', why: 'Examples give realistic happy-path data.' },
  { id: 'param-description', category: 'completeness', severity: 'info', title: 'Parameters are described', why: 'Testers need to know what a value means to pick good ones.' },
  { id: 'path-kebab-case', category: 'naming', severity: 'warning', title: 'Paths are lowercase kebab-case', why: 'Mixed case paths are easy to call wrongly.' },
  { id: 'path-no-verbs', category: 'naming', severity: 'warning', title: 'Paths name resources, not actions', why: 'The method says what happens; /getOrders hides a GET inside the path.' },
  { id: 'path-plural', category: 'naming', severity: 'info', title: 'Collections are plural', why: 'Consistent plurals make paths predictable.' },
  { id: 'no-trailing-slash', category: 'naming', severity: 'warning', title: 'No trailing slashes', why: 'Many servers treat /orders and /orders/ as different routes.' },
  { id: 'field-case', category: 'consistency', severity: 'warning', title: 'One field naming style', why: 'Mixing camelCase and snake_case makes clients and tests error-prone.' },
  { id: 'field-type', category: 'consistency', severity: 'warning', title: 'A field has one type everywhere', why: 'An id that is a number here and a string there breaks chaining.' },
  { id: 'error-shape', category: 'errors', severity: 'info', title: 'One error body shape', why: 'Tests can check errors the same way everywhere (RFC 9457 problem details is a good default).' },
  { id: 'get-no-body', category: 'http', severity: 'error', title: 'GET and DELETE have no body', why: 'Proxies and clients drop bodies on these methods.' },
  { id: 'create-returns-201', category: 'http', severity: 'info', title: 'Creating returns 201', why: 'A 201 tells clients something was created.' },
  { id: 'delete-status', category: 'http', severity: 'warning', title: 'DELETE returns 200, 202 or 204', why: 'Other codes on success confuse clients and tests.' },
  { id: 'list-paginated', category: 'pagination', severity: 'warning', title: 'Lists are paginated', why: 'An unbounded list gets slower as data grows and cannot be load tested sensibly.' },
  { id: 'version-present', category: 'versioning', severity: 'info', title: 'The API is versioned', why: 'A version in the path or server URL lets it change without breaking clients.' },
];

const WEIGHT = { error: 10, warning: 3, info: 1 } as const;
const VERBS = /^(get|fetch|create|add|update|edit|delete|remove|list|set|do|make|find|search)(?=[A-Z_-]|$)/i;
const SENSITIVE = /^(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)$/i;
const PAGINATION = /^(page|per_?page|page_?size|size|limit|offset|cursor|after|before|pageToken|page_token)$/i;

/** Every property in a schema, with its type, through refs and composition. */
function properties(doc: Obj, schema: unknown, out: { name: string; type: string; schema: Obj; pointer: string }[], pointer: string, depth = 0): void {
  const s = deref(doc, schema);
  if (!isObj(s) || depth > 4) return;
  for (const k of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach((sub, i) => properties(doc, sub, out, `${pointer}/${k}/${i}`, depth));
  if (s.items) properties(doc, s.items, out, `${pointer}/items`, depth + 1);
  if (isObj(s.properties))
    for (const [name, raw] of Object.entries(s.properties)) {
      const p = deref(doc, raw);
      if (!isObj(p)) continue;
      out.push({ name, type: String(p.type ?? (p.properties ? 'object' : p.items ? 'array' : 'unknown')), schema: p, pointer: `${pointer}/properties/${name}` });
      properties(doc, p, out, `${pointer}/properties/${name}`, depth + 1);
    }
}

const bodySchema = (doc: Obj, container: unknown): unknown => {
  const c = deref(doc, container);
  if (!isObj(c)) return undefined;
  if (c.schema) return c.schema;
  if (!isObj(c.content)) return undefined;
  const type = Object.keys(c.content).find((t) => t.includes('json')) ?? Object.keys(c.content)[0];
  return type ? (c.content[type] as Obj | undefined)?.schema : undefined;
};

/** Runs every rule that is not switched off. */
export function lintSpec(raw: unknown, disabled: Set<string> = new Set()): LintReport {
  const read = readSpec(raw);
  const doc = raw as Obj;
  const paths = doc.paths as Obj;
  const issues: LintIssue[] = [];
  const add = (rule: string, pointer: string, operation: string | null, message: string, fix: string) => {
    if (disabled.has(rule)) return;
    const r = RULES.find((x) => x.id === rule)!;
    issues.push({ rule, severity: r.severity, category: r.category, pointer, operation, message, fix });
  };
  const swagger2 = String(doc.swagger ?? '').startsWith('2.');
  const schemes = (swagger2 ? doc.securityDefinitions : isObj(doc.components) ? (doc.components as Obj).securitySchemes : undefined) as Obj | undefined;

  if (!schemes || !Object.keys(schemes).length)
    add('security-defined', swagger2 ? ptr('securityDefinitions') : ptr('components', 'securitySchemes'), null, 'No security schemes are declared.', 'Declare how clients authenticate (bearer, apiKey, oauth2) and apply it with a top-level security list.');
  for (const [name, raw] of Object.entries(schemes ?? {})) {
    const s = deref(doc, raw);
    if (isObj(s) && s.type === 'apiKey' && s.in === 'query') add('apikey-in-query', ptr(swagger2 ? 'securityDefinitions' : 'components', ...(swagger2 ? [name] : ['securitySchemes', name])), null, `The API key "${name}" is sent in the query string.`, 'Send it in a header instead, like X-API-Key.');
  }

  const fieldTypes = new Map<string, { type: string; pointer: string }[]>();
  const cases = { camel: [] as string[], snake: [] as string[] };
  const errorShapes = new Map<string, string>();
  const allServers = read.servers.join(' ');
  if (!/\/v\d+(\b|\/|$)/i.test(allServers) && !Object.keys(paths).some((p) => /^\/v\d+\//i.test(p)))
    add('version-present', ptr('servers'), null, 'Neither the server URL nor the paths carry a version like /v1.', 'Put the major version in the server URL or the first path segment.');

  for (const o of read.operations) {
    const key = `${o.method} ${o.path}`;
    const base = ptr('paths', o.path, o.method.toLowerCase());
    const op = deref(doc, (deref(doc, paths[o.path]) as Obj)[o.method.toLowerCase()]) as Obj;
    const responses = isObj(op.responses) ? op.responses : {};
    const codes = Object.keys(responses);

    if (!o.summary) add('op-summary', base, key, `${key} has no summary.`, 'Add a one-line summary that says what it does, like "Create an order".');
    if (!o.operationId) add('op-operation-id', base, key, `${key} has no operationId.`, 'Add a unique operationId in camelCase, like createOrder.');
    const ok = codes.filter((c) => /^2/.test(c));
    if (!ok.length) add('op-success-response', `${base}/responses`, key, `${key} documents no 2xx response.`, 'Document what a successful call returns.');
    if (!codes.some((c) => /^4|^5|default/i.test(c))) add('op-error-response', `${base}/responses`, key, `${key} documents no error response.`, 'Document at least the 400 or 404 it returns, with its body.');
    for (const c of ok) {
      if (c === '204') continue;
      const schema = bodySchema(doc, responses[c]);
      if (!schema) add('op-response-schema', `${base}/responses/${c}`, key, `The ${c} response of ${key} has no schema.`, 'Describe the response body with a schema, or use 204 if there is none.');
    }
    const reqBody = swagger2 ? (Array.isArray(op.parameters) ? op.parameters.map((p) => deref(doc, p) as Obj).find((p) => p?.in === 'body') : undefined) : op.requestBody;
    const hasExample = (c: unknown): boolean => {
      const x = deref(doc, c);
      if (!isObj(x)) return false;
      if (x.example !== undefined || x.examples !== undefined) return true;
      if (isObj(x.content)) return Object.values(x.content).some((m) => isObj(m) && (m.example !== undefined || m.examples !== undefined || isObj(deref(doc, m.schema)) && (deref(doc, m.schema) as Obj).example !== undefined));
      return isObj(deref(doc, x.schema)) && (deref(doc, x.schema) as Obj).example !== undefined;
    };
    if ((reqBody && !hasExample(reqBody)) || (ok[0] && ok[0] !== '204' && !hasExample(responses[ok[0]])))
      add('op-examples', base, key, `${key} has no example for its ${reqBody && !hasExample(reqBody) ? 'request body' : 'response'}.`, 'Add an example value so tests start from realistic data.');

    const params = [...(Array.isArray((deref(doc, paths[o.path]) as Obj).parameters) ? ((deref(doc, paths[o.path]) as Obj).parameters as unknown[]) : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
    params.forEach((raw, i) => {
      const p = deref(doc, raw);
      if (!isObj(p) || p.in === 'body') return;
      const name = String(p.name ?? '');
      if (!p.description) add('param-description', `${base}/parameters/${i}`, key, `Parameter ${name} of ${key} has no description.`, 'Say what the value means and what values are valid.');
      if ((p.in === 'query' || p.in === 'path') && SENSITIVE.test(name)) add('sensitive-in-url', `${base}/parameters/${i}`, key, `${key} takes ${name} in the ${p.in}.`, 'Move it to a header or the request body.');
    });

    if ((o.method === 'GET' || o.method === 'DELETE') && o.requestBody) add('get-no-body', `${base}/requestBody`, key, `${key} has a request body.`, `Send ${o.method} without a body: use query parameters, or make it a POST.`);
    const isCollection = !/\}$/.test(o.path);
    if (o.method === 'POST' && isCollection && ok.length && !ok.includes('201')) add('create-returns-201', `${base}/responses`, key, `${key} returns ${ok.join(', ')} rather than 201.`, 'Return 201 Created, with the new resource or a Location header.');
    if (o.method === 'DELETE' && ok.length && !ok.some((c) => ['200', '202', '204'].includes(c))) add('delete-status', `${base}/responses`, key, `${key} returns ${ok.join(', ')} on success.`, 'Return 204 No Content, or 200 with a body.');
    if (o.method === 'GET' && isCollection && ok[0]) {
      const schema = deref(doc, bodySchema(doc, responses[ok[0]]));
      const isList = isObj(schema) && (schema.type === 'array' || Boolean(schema.items));
      if (isList && !o.parameters.some((p) => p.in === 'query' && PAGINATION.test(p.name)))
        add('list-paginated', base, key, `${key} returns a list with no page, limit or cursor parameter.`, 'Add limit and cursor (or page and size) query parameters, with a documented maximum.');
    }

    // Response and request fields: naming style, types, sensitive fields.
    const fields: { name: string; type: string; schema: Obj; pointer: string }[] = [];
    for (const c of codes) properties(doc, bodySchema(doc, responses[c]), fields, `${base.slice(1)}/responses/${c}`);
    if (reqBody) properties(doc, bodySchema(doc, reqBody), fields, `${base.slice(1)}/requestBody`);
    for (const f of fields) {
      if (/[a-z][A-Z]/.test(f.name)) cases.camel.push(f.name);
      else if (/_/.test(f.name)) cases.snake.push(f.name);
      if (!['unknown', 'object', 'array'].includes(f.type)) fieldTypes.set(f.name, [...(fieldTypes.get(f.name) ?? []), { type: f.type, pointer: `#${f.pointer.startsWith('/') ? '' : '/'}${f.pointer}` }]);
      if (/^password/i.test(f.name) && f.schema.writeOnly !== true && f.pointer.includes('/responses/'))
        add('password-write-only', `#/${f.pointer.replace(/^#?\//, '')}`, key, `${key} can return the field ${f.name}.`, 'Mark it writeOnly: true, and never return it.');
    }
    for (const c of codes.filter((x) => /^4/.test(x))) {
      const s = deref(doc, bodySchema(doc, responses[c]));
      errorShapes.set(`${key} ${c}`, isObj(s) ? JSON.stringify(Object.keys((s.properties as Obj | undefined) ?? {}).sort()) : 'none');
    }

    // Path segments.
    const segs = o.path.split('/').filter(Boolean);
    if (o.path.length > 1 && o.path.endsWith('/')) add('no-trailing-slash', ptr('paths', o.path), key, `${o.path} ends with a slash.`, 'Drop the trailing slash.');
    segs.forEach((seg, i) => {
      if (seg.startsWith('{')) return;
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg) && !/^v\d+$/.test(seg)) add('path-kebab-case', ptr('paths', o.path), key, `The segment "${seg}" in ${o.path} is not lowercase kebab-case.`, `Rename it to ${seg.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()}.`);
      if (VERBS.test(seg)) add('path-no-verbs', ptr('paths', o.path), key, `The segment "${seg}" in ${o.path} is an action.`, 'Name the resource and let the method say what happens: POST /orders, not /createOrder.');
      const next = segs[i + 1];
      if (next?.startsWith('{') && !/s$/.test(seg) && !/^v\d+$/.test(seg)) add('path-plural', ptr('paths', o.path), key, `"${seg}" is followed by an id but is not plural.`, `Use /${seg}s/{id}.`);
    });
  }

  // Once across the whole API.
  if (cases.camel.length && cases.snake.length) {
    const minority = cases.camel.length >= cases.snake.length ? cases.snake : cases.camel;
    add('field-case', ptr('paths'), null, `Fields mix camelCase and snake_case: ${[...new Set(minority)].slice(0, 5).join(', ')} differ from the rest.`, `Pick ${cases.camel.length >= cases.snake.length ? 'camelCase' : 'snake_case'} and rename the others.`);
  }
  for (const [name, seen] of fieldTypes) {
    const types = [...new Set(seen.map((s) => s.type))];
    if (types.length > 1) add('field-type', seen[0]!.pointer, null, `The field ${name} is ${types.join(' in one place and ')} in another.`, `Give ${name} one type everywhere.`);
  }
  const shapes = new Set(errorShapes.values());
  if (shapes.size > 1) add('error-shape', ptr('paths'), null, `Errors come in ${shapes.size} different shapes across ${errorShapes.size} documented error responses.`, 'Use one error schema everywhere; RFC 9457 problem details (type, title, status, detail) is a good default.');

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const penalty = issues.reduce((n, i) => n + WEIGHT[i.severity], 0);
  // Scaled to the size of the API, so a big API is not punished for having more operations, with a base
  // allowance so one missing security block does not sink a two-operation spec to zero.
  const score = Math.max(0, Math.round(100 * (1 - penalty / (30 + read.operations.length * 12))));
  return { score, counts, issues, operations: read.operations.length, rulesRun: RULES.length - disabled.size };
}

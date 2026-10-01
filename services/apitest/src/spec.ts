import { createHash } from 'node:crypto';
import { HTTP_METHODS, type ApiAuth, type HttpMethod, type SpecChange, type SpecDiff, type SpecOperation } from '@tb/contracts';
import { parse as parseYaml } from 'yaml';

// Reads OpenAPI 3.x and Swagger 2.0 into one operation list, and compares two versions (plan §8).
// Only what the catalog and diffs need is read; the full document stays in S3 for later phases.

export class SpecError extends Error {}

export interface ReadSpec {
  format: 'openapi3' | 'swagger2';
  title: string;
  apiVersion: string;
  servers: string[];
  operations: SpecOperation[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** JSON or YAML text to a document. YAML is a superset of JSON, but JSON.parse first is much faster. */
export function parseSpecText(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t);
    } catch (err) {
      throw new SpecError(`The spec is not valid JSON: ${err instanceof Error ? err.message : ''}`);
    }
  }
  try {
    // maxAliasCount stops a "billion laughs" document from expanding into gigabytes.
    return parseYaml(t, { maxAliasCount: 100 });
  } catch (err) {
    throw new SpecError(`The spec is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : ''}`);
  }
}

/** Stable text of a document (sorted keys), so the same spec always hashes the same. */
export function normalise(doc: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(doc));
}

export const hashOf = (normalised: string) => createHash('sha256').update(normalised).digest('hex');

/** Follows a local $ref (#/components/parameters/x). Remote refs are never fetched: that would be SSRF. */
export function deref(doc: Obj, v: unknown, seen = 0): unknown {
  if (!isObj(v) || typeof v.$ref !== 'string' || seen > 10) return v;
  const ref = v.$ref;
  if (!ref.startsWith('#/')) return v;
  let at: unknown = doc;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    at = isObj(at) ? at[key] : undefined;
  }
  return deref(doc, at, seen + 1);
}

const METHOD_KEYS = HTTP_METHODS.map((m) => m.toLowerCase());

function securityNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.flatMap((req) => (isObj(req) ? Object.keys(req) : [])))].sort();
}

/** Validates the document's shape and extracts its operations. Throws SpecError with the reason. */
export function readSpec(raw: unknown): ReadSpec {
  if (!isObj(raw)) throw new SpecError('The spec must be a JSON or YAML object.');
  const doc = raw;
  const swagger2 = str(doc.swagger).startsWith('2.');
  const openapi3 = str(doc.openapi).startsWith('3.');
  if (!swagger2 && !openapi3)
    throw new SpecError('This is not an OpenAPI 3.x or Swagger 2.0 document: it needs "openapi": "3.x" or "swagger": "2.0".');
  if (!isObj(doc.paths)) throw new SpecError('The spec has no "paths" object, so there are no operations to read.');
  const info = isObj(doc.info) ? doc.info : {};

  const servers = openapi3
    ? (Array.isArray(doc.servers) ? doc.servers : []).map((s) => (isObj(s) ? str(s.url) : '')).filter(Boolean)
    : doc.host
      ? [`${Array.isArray(doc.schemes) && doc.schemes[0] ? str(doc.schemes[0]) : 'https'}://${str(doc.host)}${str(doc.basePath)}`]
      : [];
  const globalConsumes = Array.isArray(doc.consumes) ? doc.consumes.map(str) : ['application/json'];

  const operations: SpecOperation[] = [];
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    const item = deref(doc, rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const key of METHOD_KEYS) {
      const op = deref(doc, item[key]);
      if (!isObj(op)) continue;
      const params = new Map<string, SpecOperation['parameters'][number]>();
      let requestBody = null as SpecOperation['requestBody'];
      // Operation-level parameters override path-level ones with the same name and location.
      for (const rawParam of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = deref(doc, rawParam);
        if (!isObj(p)) continue;
        const where = str(p.in);
        if (swagger2 && (where === 'body' || where === 'formData')) {
          const consumes = Array.isArray(op.consumes) ? op.consumes.map(str) : globalConsumes;
          const forms = consumes.filter((c) => c.includes('form'));
          requestBody = {
            required: requestBody?.required || p.required === true,
            contentTypes: where === 'body' ? consumes : forms.length ? forms : ['application/x-www-form-urlencoded'],
          };
          continue;
        }
        if (where !== 'path' && where !== 'query' && where !== 'header' && where !== 'cookie') continue;
        params.set(`${where}:${str(p.name)}`, { name: str(p.name), in: where, required: where === 'path' || p.required === true });
      }
      if (openapi3 && op.requestBody) {
        const body = deref(doc, op.requestBody);
        if (isObj(body)) requestBody = { required: body.required === true, contentTypes: isObj(body.content) ? Object.keys(body.content) : [] };
      }
      operations.push({
        method: key.toUpperCase() as HttpMethod,
        path,
        operationId: str(op.operationId) || null,
        summary: str(op.summary) || str(op.description).split('\n')[0]!.slice(0, 200),
        tags: Array.isArray(op.tags) ? op.tags.map(str).filter(Boolean) : [],
        deprecated: op.deprecated === true,
        parameters: [...params.values()],
        requestBody,
        responses: isObj(op.responses) ? Object.keys(op.responses).sort() : [],
        security: securityNames(op.security) ?? securityNames(doc.security),
      });
    }
  }
  return {
    format: swagger2 ? 'swagger2' : 'openapi3',
    title: str(info.title).slice(0, 200) || 'Untitled API',
    apiVersion: str(info.version).slice(0, 60) || '0',
    servers,
    operations,
  };
}

export const operationKey = (o: { method: string; path: string }) => `${o.method} ${o.path}`;

/**
 * What changed between two versions, with breaking changes flagged for a client of the API: an
 * operation, parameter or response it relied on is gone, or something optional became required.
 */
export function diffSpecs(before: SpecOperation[], after: SpecOperation[], fromVersion: number): SpecDiff {
  const old = new Map(before.map((o) => [operationKey(o), o]));
  const now = new Map(after.map((o) => [operationKey(o), o]));
  const changes: SpecChange[] = [];
  const at = (o: SpecOperation) => ({ method: o.method, path: o.path });

  for (const [key, o] of now) if (!old.has(key)) changes.push({ kind: 'operation_added', breaking: false, ...at(o), detail: `${key} added` });
  for (const [key, o] of old) if (!now.has(key)) changes.push({ kind: 'operation_removed', breaking: true, ...at(o), detail: `${key} removed` });

  let changed = 0;
  for (const [key, b] of old) {
    const a = now.get(key);
    if (!a) continue;
    const before = changes.length;
    const pk = (p: SpecOperation['parameters'][number]) => `${p.in}:${p.name}`;
    const oldParams = new Map(b.parameters.map((p) => [pk(p), p]));
    const newParams = new Map(a.parameters.map((p) => [pk(p), p]));
    for (const [k, p] of newParams) {
      const was = oldParams.get(k);
      if (!was)
        changes.push({ kind: 'parameter_added', breaking: p.required, ...at(a), detail: `${p.in} parameter ${p.name} added${p.required ? ' as required' : ''}` });
      else if (p.required && !was.required)
        changes.push({ kind: 'parameter_now_required', breaking: true, ...at(a), detail: `${p.in} parameter ${p.name} is now required` });
    }
    for (const [k, p] of oldParams)
      if (!newParams.has(k)) changes.push({ kind: 'parameter_removed', breaking: false, ...at(a), detail: `${p.in} parameter ${p.name} removed` });
    if (a.requestBody?.required && !b.requestBody?.required)
      changes.push({ kind: 'body_now_required', breaking: true, ...at(a), detail: 'Request body is now required' });
    for (const code of a.responses)
      if (!b.responses.includes(code)) changes.push({ kind: 'response_added', breaking: false, ...at(a), detail: `Response ${code} documented` });
    for (const code of b.responses)
      if (!a.responses.includes(code)) changes.push({ kind: 'response_removed', breaking: true, ...at(a), detail: `Response ${code} no longer documented` });
    if (a.deprecated && !b.deprecated) changes.push({ kind: 'deprecated', breaking: false, ...at(a), detail: `${key} is deprecated` });
    if (JSON.stringify(a.security) !== JSON.stringify(b.security))
      changes.push({
        kind: 'security_changed',
        // Going from public to protected breaks every caller that sends no credentials.
        breaking: (b.security?.length ?? 0) === 0 && (a.security?.length ?? 0) > 0,
        ...at(a),
        detail: `Security ${b.security?.join(', ') || 'none'} → ${a.security?.join(', ') || 'none'}`,
      });
    if (changes.length > before) changed++;
  }

  return {
    fromVersion,
    added: changes.filter((c) => c.kind === 'operation_added').length,
    removed: changes.filter((c) => c.kind === 'operation_removed').length,
    changed,
    breaking: changes.filter((c) => c.breaking).length,
    changes,
  };
}

/**
 * The auth each named security scheme means, as a request would send it. Values are variables
 * ({{token}}, {{apiKey}}) so the environment or a workflow's login supplies them.
 */
export function schemeAuth(raw: unknown): Record<string, ApiAuth> {
  if (!isObj(raw)) return {};
  const defs = isObj(raw.components) && isObj(raw.components.securitySchemes) ? raw.components.securitySchemes : isObj(raw.securityDefinitions) ? raw.securityDefinitions : {};
  const out: Record<string, ApiAuth> = {};
  for (const [name, d] of Object.entries(defs)) {
    const def = deref(raw, d);
    if (!isObj(def)) continue;
    const type = str(def.type).toLowerCase();
    const scheme = str(def.scheme).toLowerCase();
    if (type === 'basic' || (type === 'http' && scheme === 'basic')) out[name] = { type: 'basic', username: '{{username}}', password: '{{password}}' };
    else if (type === 'http' || type === 'oauth2' || type === 'openidconnect') out[name] = { type: 'bearer', token: '{{token}}' };
    else if (type === 'apikey' && str(def.name)) out[name] = { type: 'apikey', key: str(def.name), value: '{{apiKey}}', in: str(def.in) === 'query' ? 'query' : 'header' };
  }
  return out;
}

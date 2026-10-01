import { ApiRequestDef, type ApiAuth, type ApiBody, type SpecOperation } from '@tb/contracts';

// Turns spec operations into requests for a collection: one folder per tag, {id} path segments as
// {{id}} variables, and the base URL as {{baseUrl}} so each environment points it somewhere.

export interface ImportedRequest {
  folder: string;
  name: string;
  request: ApiRequestDef;
}

const UNTAGGED = 'Other';

/** What each scheme means as auth, and the auth the target collection already applies to its requests. */
export interface ImportAuth {
  schemes: Record<string, ApiAuth>;
  collection: ApiAuth;
  /** A body the API can accept, by "METHOD /path", to start from instead of an empty one. */
  bodies?: Map<string, ApiBody>;
}

/** The collection auth that fits most of the secured operations, or none. */
export function collectionAuthFor(operations: SpecOperation[], schemes: Record<string, ApiAuth>): ApiAuth {
  const counts = new Map<string, { n: number; auth: ApiAuth }>();
  for (const o of operations) {
    const auth = o.security?.length ? schemes[o.security[0]!] : undefined;
    if (!auth) continue;
    const key = JSON.stringify(auth);
    counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, auth });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.auth ?? { type: 'none' };
}

/** A public operation says so explicitly; a secured one inherits unless it needs a different scheme than the collection. */
function authFor(o: SpecOperation, a: ImportAuth | undefined): ApiAuth {
  if (!a || o.security === null) return { type: 'inherit' };
  if (o.security.length === 0) return { type: 'none' };
  const own = a.schemes[o.security[0]!];
  if (!own || JSON.stringify(own) === JSON.stringify(a.collection)) return { type: 'inherit' };
  return own;
}

export function requestsFromOperations(specId: string, operations: SpecOperation[], version: number | null = null, auth?: ImportAuth): ImportedRequest[] {
  return operations.map((o) => {
    const path = o.path.replace(/\{([^}]+)\}/g, '{{$1}}');
    const json = o.requestBody?.contentTypes.some((c) => c.includes('json'));
    const form = !json && o.requestBody?.contentTypes.some((c) => c.includes('form'));
    return {
      folder: o.tags[0] ?? UNTAGGED,
      name: (o.summary || o.operationId || `${o.method} ${o.path}`).slice(0, 200),
      request: ApiRequestDef.parse({
        method: o.method,
        url: `{{baseUrl}}${path}`,
        // Optional parameters are listed but switched off, so the first send is the minimal valid call.
        params: o.parameters.filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: '', enabled: p.required })),
        headers: o.parameters.filter((p) => p.in === 'header').map((p) => ({ key: p.name, value: '', enabled: p.required })),
        body: json ? (auth?.bodies?.get(`${o.method} ${o.path}`) ?? { type: 'json', text: '{}' }) : form ? { type: 'form', fields: [] } : { type: 'none' },
        auth: authFor(o, auth),
        assertions: expectedStatus(o),
        operation: { specId, method: o.method, path: o.path, version },
      }),
    };
  });
}

/** A status assertion from the first documented 2xx, so an imported request already checks something. */
function expectedStatus(o: SpecOperation): ApiRequestDef['assertions'] {
  const ok = o.responses.find((r) => /^2\d\d$/.test(r));
  return ok ? [{ id: 'status', source: 'status', path: '', op: 'eq', value: ok, enabled: true }] : [];
}

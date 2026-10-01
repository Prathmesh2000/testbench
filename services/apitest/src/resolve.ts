import { randomInt, randomUUID } from 'node:crypto';
import type { ApiAuth, ApiRequestDef, ApiVariationOverrides, KeyValue } from '@tb/contracts';

// Turns a saved request plus its scopes into the exact bytes to send (plan §5). Pure: the caller loads
// and decrypts the scopes, this decides what wins and records which values were secret so the stored
// copy can be masked.

/** A variable with its value in plain text, as it is used for one send. */
export interface ResolvedVariable {
  key: string;
  value: string;
  secret: boolean;
  enabled: boolean;
}

/** Scopes from most specific to least: extracted, folder…collection, environment, workspace. */
export type Scopes = ResolvedVariable[][];

export interface ConcreteRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: Buffer | null;
  /** Every secret value that went into the request, to mask anything stored or shown. */
  secrets: string[];
  unresolved: string[];
  /** WebSocket only: the messages to send after connecting, variables filled in. */
  messages?: string[] | undefined;
}

export class ResolveError extends Error {}

const TEMPLATE = /\{\{\s*([$A-Za-z_][\w.$-]*)\s*\}\}/g;
// A variable may refer to another ({{baseUrl}} = https://{{host}}); three levels covers real use and
// stops a variable that refers to itself from looping.
const MAX_DEPTH = 3;

const DYNAMIC: Record<string, () => string> = {
  $uuid: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(randomInt(0, 1000)),
  $randomEmail: () => `user.${randomUUID().slice(0, 8)}@example.com`,
  $randomPhoneIN: () => `+91${randomInt(6, 10)}${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
};

export class Resolver {
  readonly unresolved = new Set<string>();
  readonly secrets = new Set<string>();
  private readonly lookup = new Map<string, ResolvedVariable>();

  constructor(scopes: Scopes) {
    // Least specific first, so a more specific scope overwrites.
    for (const scope of [...scopes].reverse())
      for (const v of scope) if (v.enabled && v.key) this.lookup.set(v.key, v);
  }

  /** Fills {{name}} placeholders. Unknown names stay as written and are reported. */
  fill(text: string, depth = 0): string {
    if (!text.includes('{{')) return text;
    return text.replace(TEMPLATE, (whole, key: string) => {
      const dynamic = DYNAMIC[key];
      if (dynamic) return dynamic();
      const v = this.lookup.get(key);
      if (!v) {
        this.unresolved.add(key);
        return whole;
      }
      if (v.secret && v.value) this.secrets.add(v.value);
      return depth < MAX_DEPTH ? this.fill(v.value, depth + 1) : v.value;
    });
  }

  /** Adds a secret that did not come from a variable (a password typed into Basic auth). */
  secret(value: string): string {
    if (value) this.secrets.add(value);
    return value;
  }
}

/** Every enabled variable as it resolves, most specific scope winning: what a script's tb.variables sees. */
export function flattenScopes(scopes: Scopes): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scope of [...scopes].reverse()) for (const v of scope) if (v.enabled && v.key) out[v.key] = v.value;
  return out;
}

/** Every secret value in scope, used or not: a script can read and log any of them. */
export const secretValues = (scopes: Scopes): string[] =>
  [...new Set(scopes.flat().filter((v) => v.secret && v.value).map((v) => v.value))];

/** A request with a variation's overrides applied: each field present replaces the request's own. */
export function applyVariation(def: ApiRequestDef, overrides: ApiVariationOverrides | null): ApiRequestDef {
  if (!overrides) return def;
  return {
    ...def,
    url: overrides.url ?? def.url,
    params: overrides.params ?? def.params,
    headers: overrides.headers ?? def.headers,
    body: overrides.body ?? def.body,
    auth: overrides.auth ?? def.auth,
    assertions: overrides.assertions ?? def.assertions,
  };
}

/**
 * The auth that applies: the request's own, or the nearest folder or collection that sets one.
 * `containers` runs from the request's folder up to its collection.
 */
export function effectiveAuth(own: ApiAuth, containers: ApiAuth[]): ApiAuth {
  if (own.type !== 'inherit') return own;
  return containers.find((a) => a.type !== 'inherit') ?? { type: 'none' };
}

const enabled = (rows: KeyValue[]) => rows.filter((r) => r.enabled && r.key.trim());
const hasHeader = (headers: [string, string][], name: string) =>
  headers.some(([k]) => k.toLowerCase() === name.toLowerCase());

/** Builds the concrete request. Throws ResolveError when the URL cannot be sent at all. */
export function buildRequest(def: ApiRequestDef, auth: ApiAuth, scopes: Scopes): ConcreteRequest {
  const r = new Resolver(scopes);
  const rawUrl = r.fill(def.url.trim());
  const socket = def.protocol === 'ws';
  if (!(socket ? /^wss?:\/\//i : /^https?:\/\//i).test(rawUrl))
    throw new ResolveError(
      rawUrl.includes('{{')
        ? `The URL still has an unknown variable: ${rawUrl}. Define it in the environment or the collection.`
        : socket
          ? 'A WebSocket URL must start with ws:// or wss://'
          : 'The URL must start with http:// or https://',
    );
  let url: URL;
  try {
    // WHATWG URL only knows special schemes' default ports and query handling for http(s) and ws(s) alike,
    // but parsing ws as http keeps one code path; the scheme is put back at the end.
    url = new URL(socket ? rawUrl.replace(/^ws/i, 'http') : rawUrl);
  } catch {
    throw new ResolveError(`That is not a valid URL: ${rawUrl}`);
  }
  for (const p of enabled(def.params)) url.searchParams.append(r.fill(p.key), r.fill(p.value));

  const headers: [string, string][] = enabled(def.headers).map((h) => [r.fill(h.key.trim()), r.fill(h.value)]);

  if (auth.type === 'bearer') headers.push(['Authorization', `Bearer ${r.secret(r.fill(auth.token))}`]);
  else if (auth.type === 'basic') {
    const pair = `${r.fill(auth.username)}:${r.secret(r.fill(auth.password))}`;
    headers.push(['Authorization', `Basic ${r.secret(Buffer.from(pair).toString('base64'))}`]);
  } else if (auth.type === 'apikey') {
    const value = r.secret(r.fill(auth.value));
    if (auth.in === 'header') headers.push([r.fill(auth.key), value]);
    else url.searchParams.append(r.fill(auth.key), value);
  }

  let body: Buffer | null = null;
  const b = def.body;
  const contentType = (value: string) => {
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', value]);
  };
  if (b.type === 'json') {
    body = Buffer.from(r.fill(b.text));
    contentType('application/json');
  } else if (b.type === 'text') {
    body = Buffer.from(r.fill(b.text));
    if (b.contentType) contentType(b.contentType);
  } else if (b.type === 'form') {
    const form = new URLSearchParams();
    for (const f of enabled(b.fields)) form.append(r.fill(f.key), r.fill(f.value));
    body = Buffer.from(form.toString());
    contentType('application/x-www-form-urlencoded');
  } else if (b.type === 'graphql') {
    const vars = r.fill(b.variables).trim();
    let parsed: unknown = undefined;
    if (vars) {
      try {
        parsed = JSON.parse(vars);
      } catch {
        throw new ResolveError('The GraphQL variables are not valid JSON.');
      }
    }
    body = Buffer.from(JSON.stringify({ query: r.fill(b.query), variables: parsed }));
    contentType('application/json');
  }

  const messages = socket ? (def.stream?.send ?? []).map((m) => r.fill(m)) : undefined;
  return {
    method: def.method,
    url: socket ? url.toString().replace(/^http/, 'ws') : url.toString(),
    headers,
    body,
    secrets: [...r.secrets],
    unresolved: [...r.unresolved],
    messages,
  };
}

// Credentials that are masked even when typed in as plain text rather than kept in a secret variable.
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);

/** Replaces every secret value in a text. Longest first, so a secret that contains another is caught whole. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s) out = out.split(s).join('••••••');
  return out;
}

/** Headers safe to store and show: secrets replaced, credential headers cut to their scheme. */
export function maskHeaders(headers: [string, string][], secrets: string[]): [string, string][] {
  return headers.map(([k, v]) => {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) return [k, maskSecrets(v, secrets)];
    if (k.toLowerCase() === 'cookie') return [k, v.replace(/=([^;]*)/g, '=••••••')];
    if (k.toLowerCase() === 'set-cookie') return [k, v.replace(/^([^=]+)=([^;]*)/, '$1=••••••')];
    const scheme = /^(Bearer|Basic|Digest)\s/i.exec(v)?.[1];
    return [k, scheme ? `${scheme} ••••••` : '••••••'];
  });
}

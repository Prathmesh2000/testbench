import { HTTP_METHODS, type AuthProfileConfig, type HttpMethod } from '@tb/contracts';

// Pure parts of the API assistant (plan §16): reading routes out of whatever a tester pastes, matching
// them to the catalog, finding the operations a question or requirement is about, and working out how a
// login hands out its credential. The model only ever explains or chooses among what these produce.

export interface ParsedRoute {
  method: HttpMethod;
  /** Path with parameters as {name}, the spec's style. */
  path: string;
  /** Where in the paste it came from, to show the tester. */
  source: string;
}

const METHODS = new Set<string>(HTTP_METHODS);
const toBraces = (p: string) =>
  p
    .replace(/<(?:[a-z]+:)?([A-Za-z_]\w*)>/g, '{$1}')
    .replace(/(^|\/):([A-Za-z_]\w*)/g, '$1{$2}')
    .replace(/\/+$/, '') || '/';

/**
 * Routes from a paste: "GET /orders/{id}" lines, cURL commands, Express/Fastify router calls, FastAPI
 * and Flask decorators, Spring mappings, or a HAR file. Duplicates are dropped.
 */
export function parseRoutes(text: string): ParsedRoute[] {
  const out: ParsedRoute[] = [];
  const add = (method: string, path: string, source: string) => {
    const m = method.toUpperCase();
    if (!METHODS.has(m)) return;
    let p = path.trim();
    try {
      if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
    } catch {
      return;
    }
    p = toBraces(p.split('?')[0]!);
    if (!p.startsWith('/')) p = `/${p}`;
    if (!out.some((r) => r.method === m && r.path === p)) out.push({ method: m as HttpMethod, path: p, source: source.trim().slice(0, 200) });
  };

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const har = JSON.parse(trimmed) as { log?: { entries?: { request?: { method?: string; url?: string } }[] } };
      for (const e of har.log?.entries ?? []) if (e.request?.method && e.request.url) add(e.request.method, e.request.url, `${e.request.method} ${e.request.url}`);
      if (out.length) return out;
    } catch {
      // Not a HAR file: read it line by line below.
    }
  }

  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(line))) add(m[1]!, m[2]!, line);
    else if ((m = /\b(?:router|app|server|fastify|api)\.(get|post|put|patch|delete|head|options)\(\s*['"`]([^'"`]+)['"`]/i.exec(line))) add(m[1]!, m[2]!, line);
    else if ((m = /@(?:app|router|api|bp|blueprint)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/i.exec(line))) add(m[1]!, m[2]!, line);
    else if ((m = /@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["']/.exec(line))) add(m[1]!, m[2]!, line);
    else if (/^\s*curl\b/.test(line)) {
      const method = /-X\s*['"]?([A-Z]+)/.exec(line)?.[1] ?? (/\s(-d|--data|--data-raw|--json)\b/.test(line) ? 'POST' : 'GET');
      const url = /['"]?(https?:\/\/[^\s'"]+)/.exec(line)?.[1];
      if (url) add(method, url, line);
    }
  }
  return out;
}

/** Paths match when their segments do, whatever the parameters are called: /orders/:id = /orders/{orderId}. */
export const pathShape = (p: string) => p.split('/').map((s) => (/^\{.*\}$/.test(s) ? '{}' : s.toLowerCase())).join('/');

export function matchRoute<T extends { method: string; path: string }>(route: { method: string; path: string }, catalog: T[]): T | null {
  return catalog.find((o) => o.method === route.method && pathShape(o.path) === pathShape(route.path)) ?? null;
}

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'can', 'be', 'it', 'its', 'that', 'this', 'by', 'from', 'as', 'at', 'when', 'should', 'user', 'users', 'api', 'which', 'what', 'how', 'does', 'do', 'get', 'gets']);
const VERB_METHOD: [RegExp, HttpMethod][] = [
  [/\b(create|add|new|place|register|submit|make|book|open)\b/, 'POST'],
  [/\b(update|change|edit|modify|rename|set)\b/, 'PATCH'],
  [/\b(delete|remove|cancel|close|archive)\b/, 'DELETE'],
  [/\b(list|view|see|show|read|fetch|find|search|look)\b/, 'GET'],
];
const stem = (w: string) => w.toLowerCase().replace(/(ies)$/, 'y').replace(/(es|s)$/, '').replace(/(ing|ed)$/, '');
export const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

/**
 * Operations a sentence is about, best first: words shared with the path, summary and tag, plus a bonus
 * when the sentence's verb fits the method ("cancel an order" → DELETE or POST …/cancel).
 */
export function retrieve<T extends { method: HttpMethod; path: string; summary: string; tag: string }>(sentence: string, ops: T[], limit = 8): { op: T; score: number }[] {
  const want = new Set(words(sentence));
  const verbs = VERB_METHOD.filter(([re]) => re.test(sentence.toLowerCase())).map(([, m]) => m);
  return ops
    .map((op) => {
      const have = new Set(words(`${op.path.replace(/\{[^}]+\}/g, ' ')} ${op.summary} ${op.tag}`));
      let score = 0;
      for (const w of want) if (have.has(w)) score += 2;
      if (verbs.includes(op.method) || (op.method === 'PUT' && verbs.includes('PATCH'))) score += 1;
      if (verbs.length && [...want].some((w) => op.path.toLowerCase().includes(`/${w}`) && op.method === 'POST')) score += 0.5;
      return { op, score };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length)
    .slice(0, limit);
}

export interface DetectedAuth {
  config: AuthProfileConfig;
  explanation: string;
}

const TOKEN_FIELDS = ['access_token', 'accessToken', 'token', 'id_token', 'idToken', 'jwt', 'authToken', 'auth_token', 'sessionToken'];
const SESSION_COOKIES = /^(sid|session|sessionid|connect\.sid|jsessionid|phpsessid|_session|.*session.*)$/i;
const CSRF_COOKIES: [RegExp, string][] = [
  [/^xsrf-token$/i, 'X-XSRF-TOKEN'],
  [/^csrftoken$/i, 'X-CSRFToken'],
  [/^_csrf$|^csrf[-_]?token$/i, 'X-CSRF-Token'],
];

function findToken(body: unknown, path = '$', depth = 0): string | null {
  if (!body || typeof body !== 'object' || depth > 2) return null;
  for (const f of TOKEN_FIELDS) if (typeof (body as Record<string, unknown>)[f] === 'string') return `${path}.${f}`;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const hit = findToken(v, `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** How a login response hands out its credential, read from its body, headers and cookies. */
export function detectAuth(res: { headers: [string, string][]; body: unknown }): DetectedAuth | null {
  const cookies = res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v.split('=')[0]!.trim());
  const csrf = cookies.map((c) => ({ c, h: CSRF_COOKIES.find(([re]) => re.test(c))?.[1] })).find((x) => x.h);
  const token = findToken(res.body);
  const csrfConfig = csrf ? { cookie: csrf.c, header: csrf.h! } : null;
  if (token)
    return {
      config: { extract: { source: 'body', path: token }, apply: { as: 'bearer' }, ttlSeconds: null, reloginOn401: true, csrf: csrfConfig },
      explanation: `The login returns a token at ${token}; requests send it as "Authorization: Bearer …". It is refreshed when it expires (from its exp claim, if it is a JWT) or on a 401.${csrfConfig ? ` It also sets ${csrfConfig.cookie}, copied into ${csrfConfig.header} on writes.` : ''}`,
    };
  const authHeader = res.headers.find(([k]) => /^(x-auth-token|x-access-token|authorization)$/i.test(k));
  if (authHeader)
    return {
      config: { extract: { source: 'header', path: authHeader[0] }, apply: { as: 'header', header: authHeader[0].toLowerCase() === 'authorization' ? 'Authorization' : authHeader[0], prefix: '' }, ttlSeconds: null, reloginOn401: true, csrf: csrfConfig },
      explanation: `The login returns the credential in the ${authHeader[0]} header; requests send it back in the same header.`,
    };
  const session = cookies.find((c) => SESSION_COOKIES.test(c) && !CSRF_COOKIES.some(([re]) => re.test(c)));
  if (session)
    return {
      config: { extract: { source: 'cookie', path: session }, apply: { as: 'cookie' }, ttlSeconds: null, reloginOn401: true, csrf: csrfConfig },
      explanation: `The login sets a ${session} cookie: a browser-style session. Requests send the cookie back${csrfConfig ? `, and copy ${csrfConfig.cookie} into ${csrfConfig.header} on POST, PUT, PATCH and DELETE` : ''}.`,
    };
  return null;
}

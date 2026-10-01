import { createHash } from 'node:crypto';
import type { FindingSeverity, SecurityFinding } from '@tb/contracts';
import { maskHeaders, maskSecrets } from './resolve';

// Security rules for APIs (plan §14), against the OWASP API Security Top 10 (2023). Passive checks read
// a response that was going to be fetched anyway. Active checks send probes, so they only run behind
// the safety gate; here are the probes and the verdict on what came back. Pure: no network, no database.

export interface Exchange {
  method: string;
  url: string;
  requestHeaders: [string, string][];
  requestBody: string | null;
  status: number | null;
  responseHeaders: [string, string][];
  responseBody: string;
}

type Draft = Omit<SecurityFinding, 'fingerprint' | 'evidence' | 'historyId'>;

const CUT = 1200;
const cut = (t: string) => (t.length > CUT ? `${t.slice(0, CUT)}… (cut)` : t);

/** The exchange as text for a finding, secrets masked before it is kept anywhere. */
export function evidenceOf(x: Exchange, secrets: string[]): SecurityFinding['evidence'] {
  const req = [`${x.method} ${x.url}`, ...maskHeaders(x.requestHeaders, secrets).map(([k, v]) => `${k}: ${v}`), ...(x.requestBody ? ['', cut(x.requestBody)] : [])].join('\n');
  const res = x.status === null ? '(no response)' : [`HTTP ${x.status}`, ...maskHeaders(x.responseHeaders, secrets).map(([k, v]) => `${k}: ${v}`), '', cut(x.responseBody)].join('\n');
  return { request: maskSecrets(req, secrets), response: maskSecrets(res, secrets) };
}

export function finding(d: Draft, x: Exchange, secrets: string[], extra = '', historyId: string | null = null): SecurityFinding {
  return { ...d, fingerprint: createHash('sha1').update(`${d.rule}|${d.operation ?? new URL(x.url).host}|${extra}`).digest('hex').slice(0, 20), evidence: evidenceOf(x, secrets), historyId };
}

const header = (h: [string, string][], name: string) => h.find(([k]) => k.toLowerCase() === name)?.[1];
const ok = (s: number | null) => s !== null && s >= 200 && s < 300;
const D = (rule: string, severity: FindingSeverity, owasp: string, operation: string | null, title: string, detail: string): Draft => ({ rule, severity, owasp, operation, title, detail });

// ---------- passive ----------

const STACK = /\bat [\w.$<>]+ \(.*:\d+:\d+\)|Traceback \(most recent call last\)|java\.lang\.\w+Exception|Exception in thread|SQLSTATE\[|node_modules\/|at .*\.java:\d+|in \/[\w/.-]+\.(py|rb|php):\d+/;
const SECRET_KEY = /^(password|passwd|pwd|secret|client_?secret|private_?key|api_?key|apikey|cvv|cvc|ssn|aadhaar|pan|card_?number|credit_?card|access_?key|secret_?key)$/i;
const TOKEN_KEY = /^(token|access_?token|refresh_?token|id_?token|auth_?token|session_?token|jwt)$/i;
const AUTH_URL = /(token|login|signin|sign-in|auth|session|oauth|refresh)/i;

/** Keys in a JSON value, with the path they are at, to look for fields that should never be returned. */
function keysOf(v: unknown, path = '$', depth = 0, out: { path: string; key: string; value: unknown }[] = []) {
  if (depth > 4 || out.length > 200) return out;
  if (Array.isArray(v)) v.slice(0, 5).forEach((x, i) => keysOf(x, `${path}[${i}]`, depth + 1, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    out.push({ path: `${path}.${k}`, key: k, value: x });
    keysOf(x, `${path}.${k}`, depth + 1, out);
  }
  return out;
}

/** What a response gives away without anyone asking: headers, cookies, error detail, fields. */
export function passiveChecks(x: Exchange, ctx: { operation: string | null; authSent: boolean; json: unknown }, secrets: string[]): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  if (x.status === null) return out;
  const op = ctx.operation;
  const url = new URL(x.url);
  const add = (d: Draft, extra = '') => out.push(finding(d, x, secrets, extra));

  if (url.protocol === 'https:' && ok(x.status) && !header(x.responseHeaders, 'strict-transport-security'))
    add(D('missing-hsts', 'low', 'API8:2023 Security Misconfiguration', op, 'No Strict-Transport-Security header', 'Browsers are not told to use HTTPS only, so a first visit over http can be intercepted. Send Strict-Transport-Security: max-age=31536000.'));
  if (ok(x.status) && header(x.responseHeaders, 'x-content-type-options')?.toLowerCase() !== 'nosniff' && /json|html|text/.test(header(x.responseHeaders, 'content-type') ?? ''))
    add(D('missing-nosniff', 'low', 'API8:2023 Security Misconfiguration', op, 'No X-Content-Type-Options: nosniff', 'A browser may guess a different content type than the one sent. Send X-Content-Type-Options: nosniff.'));
  const acao = header(x.responseHeaders, 'access-control-allow-origin');
  if (acao === '*' && header(x.responseHeaders, 'access-control-allow-credentials')?.toLowerCase() === 'true')
    add(D('cors-wildcard-credentials', 'high', 'API8:2023 Security Misconfiguration', op, 'CORS allows every origin with credentials', 'Access-Control-Allow-Origin: * together with Allow-Credentials: true lets any website read this API as the signed-in user.'));
  if (ctx.authSent && ok(x.status) && /json/.test(header(x.responseHeaders, 'content-type') ?? '') && !/no-store|private/i.test(header(x.responseHeaders, 'cache-control') ?? ''))
    add(D('cache-sensitive', 'low', 'API8:2023 Security Misconfiguration', op, 'An authenticated response can be cached', 'No Cache-Control: no-store or private on a response for a signed-in user: a shared cache could keep it for someone else.'));
  for (const name of ['server', 'x-powered-by', 'x-aspnet-version']) {
    const v = header(x.responseHeaders, name);
    if (v && /\d+\.\d+/.test(v)) add(D('server-version', 'low', 'API8:2023 Security Misconfiguration', null, `The ${name} header shows a software version`, `${name}: ${v}. Version numbers help an attacker pick known exploits; remove or generalise the header.`), name);
  }
  if (x.status >= 500 && STACK.test(x.responseBody))
    add(D('verbose-error', 'medium', 'API8:2023 Security Misconfiguration', op, 'An error response shows internals', 'The body of a server error carries a stack trace or framework detail. Return a short generic message and log the rest.'));
  for (const [k, v] of x.responseHeaders) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const name = v.split('=')[0]!.trim();
    const flags = v.toLowerCase();
    const session = /sess|sid|token|auth|jwt/i.test(name);
    const missing = [session && !flags.includes('httponly') ? 'HttpOnly' : '', url.protocol === 'https:' && !flags.includes('secure') ? 'Secure' : '', !flags.includes('samesite') ? 'SameSite' : ''].filter(Boolean);
    if (missing.length) add(D('cookie-flags', session ? 'medium' : 'low', 'API2:2023 Broken Authentication', op, `Cookie ${name} lacks ${missing.join(', ')}`, `Set the ${missing.join(', ')} attribute${missing.length > 1 ? 's' : ''} so the cookie is not readable by scripts, sent over plain http or sent cross-site.`), name);
  }
  if (ok(x.status) && ctx.json !== undefined) {
    const seen = new Set<string>();
    for (const { path, key, value } of keysOf(ctx.json)) {
      if (typeof value !== 'string' || !value || seen.has(key)) continue;
      const secret = SECRET_KEY.test(key);
      const token = TOKEN_KEY.test(key) && !AUTH_URL.test(url.pathname);
      if (!secret && !token) continue;
      seen.add(key);
      add(D('sensitive-field-exposed', secret ? 'high' : 'medium', 'API3:2023 Broken Object Property Level Authorization', op, `The response returns ${key}`, `${path} holds a value that looks like a ${secret ? 'secret or personal identifier' : 'credential'}. Remove it from this response, or return it only where it is needed.`), key);
    }
  }
  return out;
}

// ---------- active: probes and verdicts ----------

/** Credentials that must all be refused: none, junk, and a real token with its signature broken. */
export function tamperedAuth(value: string): { label: string; value: string | null }[] {
  const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1];
  const out: { label: string; value: string | null }[] = [{ label: 'no credential', value: null }, { label: 'an invalid token', value: 'Bearer invalid.token.value' }, { label: 'an empty token', value: 'Bearer ' }];
  const parts = bearer?.split('.');
  if (parts?.length === 3) {
    const sig = parts[2]!;
    out.push({ label: 'a token with a broken signature', value: `Bearer ${parts[0]}.${parts[1]}.${sig.slice(0, -4)}${sig.endsWith('AAAA') ? 'BBBB' : 'AAAA'}` });
    out.push({ label: 'an unsigned token (alg none)', value: `Bearer ${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${parts[1]}.` });
  }
  return out;
}

export const looksPrivileged = (o: { path: string; tag: string; summary: string }) => /(^|\/)(admin|internal|manage|management|backoffice|staff|superuser|root)(\/|$)/i.test(o.path) || /\b(admin|internal|staff|backoffice)\b/i.test(`${o.tag} ${o.summary}`);

export const MASS_FIELDS: [string, unknown][] = [['isAdmin', true], ['is_admin', true], ['admin', true], ['role', 'admin'], ['roles', ['admin']], ['verified', true], ['balance', 999999], ['status', 'approved'], ['price', 0]];

/** Privileged-looking fields the body does not already have, to see whether the API takes them anyway. */
export function massAssignmentFields(body: Record<string, unknown>): [string, unknown][] {
  return MASS_FIELDS.filter(([k]) => !(k in body)).slice(0, 5);
}

export function massAssignmentVerdict(sent: [string, unknown][], status: number | null, responseJson: unknown): [string, unknown][] {
  if (!ok(status) || !responseJson || typeof responseJson !== 'object') return [];
  const body = (Array.isArray(responseJson) ? responseJson[0] : responseJson) as Record<string, unknown> | undefined;
  const flat = (body && typeof (body as { data?: unknown }).data === 'object' ? (body as { data: Record<string, unknown> }).data : body) ?? {};
  return sent.filter(([k, v]) => k in flat && JSON.stringify(flat[k]) === JSON.stringify(v));
}

export const INJECTION: { id: string; payload: string; kind: 'sql' | 'xss' | 'traversal' | 'template' }[] = [
  { id: 'sql-quote', payload: "tb'\"--", kind: 'sql' },
  { id: 'sql-or', payload: "' OR '1'='1", kind: 'sql' },
  { id: 'xss', payload: '<script>tb-xss</script>', kind: 'xss' },
  { id: 'traversal', payload: '../../../../etc/passwd', kind: 'traversal' },
  { id: 'template', payload: '${{7*7}}{{7*7}}', kind: 'template' },
];

const SQL_ERROR = /sql syntax|sqlstate|unterminated quoted|syntax error at or near|ORA-\d{5}|sqlite[_ ]error|mysql_|pg_query|psycopg|unclosed quotation|SequelizeDatabaseError|QueryFailedError|PG::/i;

/** Did the API mishandle a probe? A server error or a database error text is a problem; so is a script echoed back raw. */
export function injectionVerdict(p: (typeof INJECTION)[number], baselineStatus: number, status: number | null, body: string, contentType: string): { title: string; detail: string; severity: FindingSeverity } | null {
  if (status === null) return null;
  if (SQL_ERROR.test(body)) return { title: 'A probe produced a database error', detail: `Sending ${p.payload} made the API return text from its database. Use parameterised queries and return a generic error.`, severity: 'high' };
  if (p.kind === 'traversal' && /root:[x*]?:0:0:/.test(body)) return { title: 'A path traversal probe read a file', detail: 'Sending ../../../../etc/passwd returned the contents of a system file. Never build file paths from input.', severity: 'high' };
  if (p.kind === 'template' && body.includes('49') && !body.includes(p.payload) && baselineStatus < 400) return { title: 'A template probe was evaluated', detail: 'Sending {{7*7}} came back as 49: input is being run as a template. Treat it as text.', severity: 'high' };
  if (status >= 500 && baselineStatus < 500) return { title: 'A probe made the API fail with a server error', detail: `Sending ${p.payload} turned a ${baselineStatus} into a ${status}. Input that breaks the server is a place to look for worse. Validate it and return a 4xx.`, severity: 'medium' };
  if (p.kind === 'xss' && body.includes(p.payload) && /html/.test(contentType)) return { title: 'A script probe was returned unescaped in HTML', detail: 'The <script> sent in was returned as it was in an HTML response. Escape output, or return JSON.', severity: 'high' };
  return null;
}

export function corsVerdict(origin: string, h: [string, string][]): { title: string; detail: string; severity: FindingSeverity } | null {
  const acao = header(h, 'access-control-allow-origin');
  const creds = header(h, 'access-control-allow-credentials')?.toLowerCase() === 'true';
  if (acao === origin && creds) return { title: 'CORS trusts any origin with credentials', detail: `A request from ${origin} was allowed, with cookies and tokens, because the API echoes whatever Origin it is sent. Allow only a list of known origins.`, severity: 'high' };
  if (acao === '*' && creds) return { title: 'CORS allows every origin with credentials', detail: 'Access-Control-Allow-Origin: * with Allow-Credentials: true.', severity: 'high' };
  if (acao === origin) return { title: 'CORS echoes any origin', detail: `${origin} was allowed. Without credentials the harm is limited, but allow only the origins that need it.`, severity: 'low' };
  return null;
}

export function rateVerdict(statuses: (number | null)[], h: [string, string][]): { title: string; detail: string; severity: FindingSeverity } | null {
  const limited = statuses.some((s) => s === 429) || h.some(([k]) => /^(x-)?ratelimit|retry-after/i.test(k));
  return limited ? null : { title: 'No rate limiting seen', detail: `${statuses.length} requests in a burst were all answered, with no 429 and no rate limit headers. Without limits one client can use up the API for everyone.`, severity: 'low' };
}

/** The same account's data returned to a different account is a broken object level authorisation. */
export function bolaVerdict(baseline: { status: number | null; body: string }, other: { status: number | null; body: string }): 'leak' | 'unclear' | null {
  if (!ok(other.status) || !ok(baseline.status)) return null;
  if (!other.body.trim()) return 'unclear';
  return other.body === baseline.body || (Math.abs(other.body.length - baseline.body.length) < Math.max(20, baseline.body.length * 0.1) && sharesKeys(baseline.body, other.body)) ? 'leak' : 'unclear';
}

function sharesKeys(a: string, b: string): boolean {
  try {
    const ka = Object.keys(JSON.parse(a) as object);
    const kb = new Set(Object.keys(JSON.parse(b) as object));
    return ka.length > 0 && ka.filter((k) => kb.has(k)).length / ka.length >= 0.8;
  } catch {
    return false;
  }
}

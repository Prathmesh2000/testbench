import { createPrivateKey, X509Certificate } from 'node:crypto';
import type { AuthProfileConfig } from '@tb/contracts';
import { queryPath, type ResponseFacts } from './assert';
import { cookieHeader, type StoredCookie } from './cookies';

// Rules for auth profiles and client certificates (plan §4, §16.5), with no database: what a login
// produced, how long it lasts, how it goes on a request, and which certificate a URL gets.

export class ProfileError extends Error {}

/** Seconds of slack before expiry, so a token is not used in the second it runs out. */
const SKEW_MS = 30_000;

/** A JWT's exp claim, when the credential is a JWT. Signature is not checked: it only guides refresh. */
export function jwtExpiry(token: string): number | null {
  const parts = token.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** When a session must be renewed: the profile's TTL, else the JWT's exp, else only on a 401 (null). */
export function sessionExpiry(token: string, ttlSeconds: number | null, now: number): number | null {
  if (ttlSeconds) return now + ttlSeconds * 1000;
  const exp = jwtExpiry(token);
  return exp === null ? null : exp - SKEW_MS;
}

/** Pulls the credential out of the login response. Throws with the reason when it is not there. */
export function extractCredential(config: AuthProfileConfig, facts: ResponseFacts, jar: StoredCookie[], url: URL, now: number): string {
  const { source, path } = config.extract;
  let value: unknown;
  if (source === 'header') value = facts.headers.find(([k]) => k.toLowerCase() === path.toLowerCase())?.[1];
  else if (source === 'cookie') {
    const { header } = cookieHeader(jar.filter((c) => c.name === path), url, now);
    value = header ? header.slice(path.length + 1) : undefined;
  } else {
    if (facts.json === undefined) throw new ProfileError(`The login response is not JSON, so ${path} could not be read.`);
    value = queryPath(facts.json, path)[0];
  }
  if (value === undefined || value === null || value === '')
    throw new ProfileError(`The login response has no ${source === 'body' ? `value at ${path}` : `${source} ${path}`}. Check the profile's "where the credential is" setting.`);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Headers with the credential set, replacing any header of the same name the request already had. */
export function applyCredential(headers: [string, string][], apply: AuthProfileConfig['apply'], token: string): [string, string][] {
  if (apply.as === 'cookie') return headers;
  const [name, value] = apply.as === 'bearer' ? ['Authorization', `Bearer ${token}`] : [apply.header, `${apply.prefix}${token}`];
  return [...headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase()), [name, value]];
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The CSRF header for a state-changing request, copied from its cookie, or null when none applies. */
export function csrfHeader(config: AuthProfileConfig, jar: StoredCookie[], url: URL, method: string, now: number): [string, string] | null {
  if (!config.csrf || !UNSAFE.has(method)) return null;
  const { header } = cookieHeader(jar.filter((c) => c.name === config.csrf!.cookie), url, now);
  return header ? [config.csrf.header, decodeURIComponent(header.slice(config.csrf.cookie.length + 1))] : null;
}

/** For a cookie-only profile: whether the jar already holds a live session cookie for this URL. */
export const hasSessionCookie = (config: AuthProfileConfig, jar: StoredCookie[], url: URL, now: number) =>
  config.extract.source === 'cookie' && cookieHeader(jar.filter((c) => c.name === config.extract.path), url, now).header !== null;

// ---------- client certificates ----------

export interface CertBundle {
  cert?: string | undefined;
  key?: string | undefined;
  passphrase?: string | undefined;
  ca?: string | undefined;
}

/** Checks a bundle before it is stored: the certificate parses, the key opens and belongs to it. */
export function inspectBundle(b: CertBundle): { subject: string; expiresAt: Date | null } {
  let x509: X509Certificate | null = null;
  try {
    if (b.cert) x509 = new X509Certificate(b.cert);
    else if (b.ca) x509 = new X509Certificate(b.ca);
  } catch {
    throw new ProfileError('The certificate could not be read. Paste the whole PEM, including the BEGIN and END lines.');
  }
  if (b.cert && b.key) {
    let key;
    try {
      key = createPrivateKey({ key: b.key, passphrase: b.passphrase || undefined });
    } catch {
      throw new ProfileError(b.passphrase ? 'The private key could not be opened with that passphrase.' : 'The private key could not be read. If it is encrypted, give its passphrase.');
    }
    if (!x509!.checkPrivateKey(key)) throw new ProfileError('That private key does not belong to that certificate.');
  }
  return { subject: (x509!.subject.split('\n').find((l) => l.startsWith('CN=')) ?? x509!.subject.split('\n')[0] ?? '').slice(0, 300), expiresAt: new Date(x509!.validTo) };
}

/** The certificate for a URL: an exact host (and port) wins over a wildcard; no port matches any port. */
export function certFor<T extends { host: string }>(certs: T[], url: URL): T | null {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const score = (c: T): number => {
    const [pattern, want] = c.host.split(':') as [string, string | undefined];
    if (want && want !== port) return 0;
    const wild = pattern.startsWith('*.');
    const match = wild ? host.endsWith(pattern.slice(1)) && host !== pattern.slice(2) : host === pattern;
    if (!match) return 0;
    return (wild ? 1 : 3) + (want ? 1 : 0);
  };
  let best: T | null = null;
  let bestScore = 0;
  for (const c of certs) {
    const s = score(c);
    if (s > bestScore) [best, bestScore] = [c, s];
  }
  return best;
}

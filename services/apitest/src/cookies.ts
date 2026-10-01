import type { CookieView } from '@tb/contracts';

// A cookie jar that follows browser rules (RFC 6265), so a login that sets a session cookie works for the
// requests after it the way it would in a browser (plan §16.5).
// ponytail: no public suffix list, so a site could set a cookie for a whole registrable suffix like
// co.in. Jars are per tester and per environment, which limits the harm; add the list if jars are shared.

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch ms; null for a session cookie, which lives as long as the jar. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  /** Set without a Domain attribute: sent to that exact host only. */
  hostOnly: boolean;
}

const MAX_COOKIES = 300;

/** Browsers treat http://localhost as secure, so Secure cookies from a local API still round-trip. */
const isSecureOrigin = (url: URL) =>
  url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';

function defaultPath(url: URL): string {
  const p = url.pathname;
  if (!p.startsWith('/') || p.lastIndexOf('/') === 0) return '/';
  return p.slice(0, p.lastIndexOf('/'));
}

export function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
}

export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** One Set-Cookie header, or null when the browser would reject it (wrong domain, Secure over http). */
export function parseSetCookie(header: string, url: URL, now: number): StoredCookie | null {
  const [pair, ...attrs] = header.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return null;
  const cookie: StoredCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname.toLowerCase(),
    path: defaultPath(url),
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
    hostOnly: true,
  };
  let maxAge: number | null = null;
  for (const attr of attrs) {
    const [rawKey, ...rest] = attr.split('=');
    const key = rawKey!.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'domain' && value) {
      const d = value.replace(/^\./, '').toLowerCase();
      if (!domainMatches(url.hostname.toLowerCase(), d)) return null;
      cookie.domain = d;
      cookie.hostOnly = false;
    } else if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'expires') {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) cookie.expires = t;
    } else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = value || null;
  }
  // Max-Age wins over Expires; zero or less means delete now.
  if (maxAge !== null) cookie.expires = now + maxAge * 1000;
  if (cookie.secure && !isSecureOrigin(url)) return null;
  return cookie;
}

const sameCookie = (a: StoredCookie, b: StoredCookie) => a.name === b.name && a.domain === b.domain && a.path === b.path;

/** The jar after a response's Set-Cookie headers. Expired cookies are dropped, including deletions. */
export function storeCookies(jar: StoredCookie[], setCookies: string[], url: URL, now: number): { jar: StoredCookie[]; set: string[] } {
  let next = jar.filter((c) => c.expires === null || c.expires > now);
  const set: string[] = [];
  for (const header of setCookies) {
    const c = parseSetCookie(header, url, now);
    if (!c) continue;
    next = next.filter((x) => !sameCookie(x, c));
    if (c.expires === null || c.expires > now) {
      next.push(c);
      set.push(c.name);
    }
  }
  return { jar: next.slice(-MAX_COOKIES), set };
}

/** The Cookie header for a URL, longest path first as browsers send it, or null when nothing applies. */
export function cookieHeader(jar: StoredCookie[], url: URL, now: number): { header: string | null; names: string[] } {
  const host = url.hostname.toLowerCase();
  const matching = jar
    .filter((c) => c.expires === null || c.expires > now)
    .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)))
    .filter((c) => pathMatches(url.pathname || '/', c.path))
    .filter((c) => !c.secure || isSecureOrigin(url))
    .sort((a, b) => b.path.length - a.path.length);
  if (!matching.length) return { header: null, names: [] };
  return { header: matching.map((c) => `${c.name}=${c.value}`).join('; '), names: matching.map((c) => c.name) };
}

/** What the builder shows: everything but the value. */
export const cookieView = (c: StoredCookie): CookieView => ({
  name: c.name,
  domain: c.domain,
  path: c.path,
  expires: c.expires === null ? null : new Date(c.expires).toISOString(),
  secure: c.secure,
  httpOnly: c.httpOnly,
  sameSite: c.sameSite,
});

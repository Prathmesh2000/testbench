import { createHash } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import * as oidc from 'openid-client';

// Server-only: imported by route handlers and server components, never by client components.
//
// Tokens live in encrypted, httpOnly cookies, so page JavaScript (and anything injected into it) can
// never read them. The browser only ever calls /api/core/*, which this server forwards to core-api with
// the bearer token attached (see app/api/core/[...path]/route.ts).

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env at the repository root.`);
  return value;
};

export const COOKIE = { access: 'tb_at', refresh: 'tb_rt', login: 'tb_login' } as const;
const secure = process.env.NODE_ENV === 'production';
export const cookieOptions = (maxAgeSeconds: number) =>
  ({ httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: maxAgeSeconds }) as const;

// A stable 256-bit key derived from SESSION_SECRET, whatever its length.
let key: Uint8Array | undefined;
const encryptionKey = () => (key ??= createHash('sha256').update(env('SESSION_SECRET')).digest());

export async function seal(payload: Record<string, unknown>, maxAgeSeconds: number): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds}s`)
    .encrypt(encryptionKey());
}

/** Returns null for a missing, tampered or expired cookie; callers treat all three as "signed out". */
export async function unseal<T>(value: string | undefined): Promise<T | null> {
  if (!value) return null;
  try {
    const { payload } = await jwtDecrypt(value, encryptionKey());
    return payload as T;
  } catch {
    return null;
  }
}

let config: Promise<oidc.Configuration> | undefined;
/** OIDC discovery, done once per server process. */
export function oidcConfig(): Promise<oidc.Configuration> {
  config ??= oidc
    .discovery(new URL(env('OIDC_ISSUER')), env('OIDC_CLIENT_ID'), env('OIDC_CLIENT_SECRET'), undefined, {
      // Keycloak runs on plain HTTP in local development only; production refuses anything but HTTPS.
      execute: process.env.OIDC_ALLOW_HTTP === 'true' ? [oidc.allowInsecureRequests] : [],
    })
    .catch((err) => {
      config = undefined; // retry discovery on the next request instead of caching the failure
      throw err;
    });
  return config;
}

export const webUrl = () => env('WEB_URL');
export const coreApiUrl = () => env('CORE_API_URL');

export interface AccessCookie {
  at: string;
  /** Epoch seconds when the access token expires. */
  exp: number;
}

/** Sealed cookie values for a fresh token set. The refresh token outlives the access token. */
export async function sessionCookies(tokens: oidc.TokenEndpointResponse) {
  const expiresIn = tokens.expires_in ?? 300;
  const refreshMaxAge = 8 * 3600;
  return {
    access: { value: await seal({ at: tokens.access_token, exp: Math.floor(Date.now() / 1000) + expiresIn }, expiresIn), maxAge: expiresIn },
    refresh: tokens.refresh_token ? { value: await seal({ rt: tokens.refresh_token }, refreshMaxAge), maxAge: refreshMaxAge } : null,
  };
}

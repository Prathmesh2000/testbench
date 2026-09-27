import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from './errors';

export interface VerifiedToken {
  subject: string;
  email: string;
  name: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

interface VerifierOptions {
  issuer: string;
  audience: string;
  /** Signing keys. Production passes the IdP's remote key set; tests pass a local one. */
  keys: JWTVerifyGetKey;
}

/**
 * Verifies an access token issued by our OIDC provider: signature, issuer, audience and expiry.
 * The audience check matters: Keycloak issues tokens for many clients, and only tokens minted for
 * core-api may call it.
 */
export function createTokenVerifier({ issuer, audience, keys }: VerifierOptions): TokenVerifier {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256', 'ES256'] });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw new AppError(401, 'unauthenticated', 'The token has no subject or email');
      }
      const name = typeof payload.name === 'string' && payload.name ? payload.name : payload.email;
      return { subject: payload.sub, email: payload.email.toLowerCase(), name };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(401, 'unauthenticated', 'Your session has expired or is invalid. Sign in again.');
    }
  };
}

/** Looks up the provider's key set through standard OIDC discovery, so nothing here is Keycloak-specific. */
export async function discoverRemoteKeys(issuer: string): Promise<JWTVerifyGetKey> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const { jwks_uri: jwksUri } = (await res.json()) as { jwks_uri?: string };
  if (!jwksUri) throw new Error(`OIDC discovery for ${issuer} returned no jwks_uri`);
  return createRemoteJWKSet(new URL(jwksUri));
}

import { AppError, type Db, type JsonCache, type TokenVerifier } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { resolveIdentity, type AuthContext } from './identity';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

interface AuthPluginOptions {
  db: Db;
  cache: JsonCache;
  verify: TokenVerifier;
  /** Routes that must work without a token (health checks). */
  publicPaths: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticates every request with a bearer token and attaches `req.auth`. Registered with
 * fastify-plugin so the hook applies to routes registered by sibling plugins (repository, execution).
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  app.decorateRequest('auth', null as unknown as AuthContext);

  app.addHook('onRequest', async (req) => {
    if (opts.publicPaths.includes(req.routeOptions.url ?? '')) return;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    const token = await opts.verify(header.slice('Bearer '.length));
    const orgHeader = req.headers['x-org-id'];
    const requestedOrg = typeof orgHeader === 'string' && UUID.test(orgHeader) ? orgHeader : undefined;
    req.auth = await resolveIdentity(opts.db, opts.cache, token, requestedOrg);
  });
};

export default fp(authPlugin, { name: 'tb-auth' });

import { AppError, type Db, type JsonCache, type TokenVerifier } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { resolveIdentity, resolveTokenIdentity, type AuthContext } from './identity';

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
export const TOKEN_PREFIX = 'tbp_';
// Search is a POST (the query is a body) but reads only, so read-only tokens may use it.
const READ_ONLY_POSTS = /\/search(\/keys)?$/;

/**
 * Authenticates every request with a bearer token (a Keycloak access token, or a personal access token
 * for CI, MCP and Slack) and attaches `req.auth`. Registered with
 * fastify-plugin so the hook applies to routes registered by sibling plugins (repository, execution).
 */
const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  app.decorateRequest('auth', null as unknown as AuthContext);

  app.addHook('onRequest', async (req) => {
    if (opts.publicPaths.includes(req.routeOptions.url ?? '')) return;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    const bearer = header.slice('Bearer '.length);
    if (bearer.startsWith(TOKEN_PREFIX)) {
      const client = req.headers['x-tb-client'];
      req.auth = await resolveTokenIdentity(
        opts.db,
        opts.cache,
        bearer,
        typeof client === 'string' ? client : undefined,
      );
      const reads =
        req.method === 'GET' ||
        req.method === 'HEAD' ||
        (req.method === 'POST' && READ_ONLY_POSTS.test(req.routeOptions.url ?? ''));
      if (!reads && !req.auth.scopes?.includes('write'))
        throw new AppError(403, 'insufficient_scope', 'This access token is read-only.');
      return;
    }
    const token = await opts.verify(bearer);
    const orgHeader = req.headers['x-org-id'];
    const requestedOrg = typeof orgHeader === 'string' && UUID.test(orgHeader) ? orgHeader : undefined;
    req.auth = await resolveIdentity(opts.db, opts.cache, token, requestedOrg);
  });
};

export default fp(authPlugin, { name: 'tb-auth' });

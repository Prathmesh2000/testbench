import { executionRoutes } from '@tb/execution';
import { authPlugin, iamRoutes } from '@tb/iam';
import { installErrorHandler, type ServiceDeps, type TokenVerifier } from '@tb/platform';
import { repositoryRoutes } from '@tb/repository';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { sql } from 'kysely';

export interface AppOptions extends ServiceDeps {
  verify: TokenVerifier;
  logLevel?: string;
}

/**
 * Builds the core-api deploy unit (HLD §1.1): IAM, Test Repository and Execution mounted in one
 * process under /api/v1. Kept separate from server.ts so tests can build it with their own
 * dependencies (a local signing key instead of Keycloak) and call it with inject().
 */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Evidence goes straight to S3, so API bodies are small; a tight limit makes oversized abuse cheap to reject.
    bodyLimit: 1024 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  installErrorHandler(app);

  // Liveness: the process is up. Readiness: its dependencies answer, so the load balancer can route to it.
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const [database, cache] = await Promise.all([
      sql`SELECT 1`.execute(opts.db).then(
        () => true,
        () => false,
      ),
      opts.cache.ping(),
    ]);
    return reply.status(database && cache ? 200 : 503).send({ database, cache });
  });

  const deps: ServiceDeps = { db: opts.db, cache: opts.cache, storage: opts.storage };
  await app.register(
    async (api) => {
      await api.register(authPlugin, {
        db: opts.db,
        cache: opts.cache,
        verify: opts.verify,
        publicPaths: [],
      });
      await api.register(iamRoutes, deps);
      await api.register(repositoryRoutes, deps);
      await api.register(executionRoutes, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

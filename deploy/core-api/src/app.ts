import { defectRoutes, jiraWebhook, type JiraClient } from '@tb/defect';
import { executionRoutes } from '@tb/execution';
import { authPlugin, iamRoutes } from '@tb/iam';
import { installErrorHandler, type ServiceDeps, type TokenVerifier } from '@tb/platform';
import { repositoryRoutes } from '@tb/repository';
import { searchRoutes, type CaseIndex } from '@tb/search';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { sql } from 'kysely';

export interface AppOptions extends ServiceDeps {
  verify: TokenVerifier;
  index: CaseIndex;
  jira: JiraClient | null;
  webUrl: string;
  logLevel?: string;
}

/**
 * Builds the core-api deploy unit (HLD §1.1): IAM, Test Repository, Execution, Search and Defect
 * Integration mounted in one process under /api/v1, plus the Jira webhook. Kept separate from
 * server.ts so tests can build it with their own dependencies and call it with inject().
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
    const [database, cache, search] = await Promise.all([
      sql`SELECT 1`.execute(opts.db).then(
        () => true,
        () => false,
      ),
      opts.cache.ping(),
      opts.index.ping(),
    ]);
    return reply.status(database && cache && search ? 200 : 503).send({ database, cache, search });
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
      await api.register(searchRoutes, { ...deps, index: opts.index });
      await api.register(defectRoutes, { ...deps, jira: opts.jira, webUrl: opts.webUrl });
    },
    { prefix: '/api/v1' },
  );

  if (opts.jira) await app.register(jiraWebhook, { db: opts.db, secret: opts.jira.cfg.webhookSecret });

  return app;
}

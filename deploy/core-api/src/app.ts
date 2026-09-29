import { aiRoutes, type AiService } from '@tb/ai';
import { analyticsRoutes } from '@tb/analytics';
import { collabRoutes, type CollabOptions } from '@tb/collab';
import { defectRoutes, type JiraAccounts } from '@tb/defect';
import { docsRoutes } from '@tb/docs';
import { executionRoutes } from '@tb/execution';
import { meetingRoutes } from '@tb/meetings';
import { notifyRoutes, type NotifyClient } from '@tb/notify-client';
import { adminRoutes, authPlugin, iamRoutes, type KeycloakAdmin } from '@tb/iam';
import { auditRoutes } from '@tb/audit';
import { installErrorHandler, type ServiceDeps, type TokenVerifier } from '@tb/platform';
import { repositoryRoutes } from '@tb/repository';
import { searchRoutes, type CaseIndex } from '@tb/search';
import { studioRoutes, type BrowserConfig } from '@tb/studio';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { integrationRoutes } from './integrations';

export interface AppOptions extends ServiceDeps {
  verify: TokenVerifier;
  index: CaseIndex;
  /** Per-tester Jira connections. */
  jira: JiraAccounts;
  notify: NotifyClient | null;
  ai: AiService;
  keycloak: KeycloakAdmin | null;
  /** For the Integrations tab. */
  issuer: string;
  gatewayUrl: string | null;
  collab: CollabOptions;
  /** Test Browser server and the secret its session tickets are signed with. */
  browser: BrowserConfig;
  calendarUrl: string | null;
  webUrl: string;
  logLevel?: string;
}

/**
 * Builds the core-api deploy unit (HLD §1.1): IAM, Test Repository, Execution, Search, Defect
 * Integration, Analytics, Docs and AI Assist mounted in one process under /api/v1. Kept separate from
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
        // The locator picker runs on the tester's own site with no session; it carries a signed,
        // short-lived ticket that the handler verifies instead.
        publicPaths: ['/api/v1/studio/picker/captured'],
      });
      await api.register(iamRoutes, deps);
      await api.register(adminRoutes, { ...deps, keycloak: opts.keycloak });
      await api.register(auditRoutes, deps);
      await api.register(integrationRoutes, { ...deps, opts });
      await api.register(repositoryRoutes, deps);
      await api.register(executionRoutes, deps);
      await api.register(searchRoutes, { ...deps, index: opts.index });
      await api.register(defectRoutes, { ...deps, accounts: opts.jira, webUrl: opts.webUrl });
      await api.register(analyticsRoutes, deps);
      await api.register(docsRoutes, { ...deps, ai: opts.ai });
      await api.register(aiRoutes, { ...deps, ai: opts.ai });
      await api.register(collabRoutes, { ...deps, collab: opts.collab });
      await api.register(meetingRoutes, { ...deps, calendarUrl: opts.calendarUrl });
      await api.register(studioRoutes, { ...deps, browser: opts.browser, webUrl: opts.webUrl });
      if (opts.notify) await api.register(notifyRoutes, { ...deps, client: opts.notify });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

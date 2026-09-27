import { AiConfigBody, AiKeyBody, EdgeCasesBody, parseCaseKey } from '@tb/contracts';
import { projectTx } from '@tb/iam';
import { notFound, type ServiceDeps, type StepJson } from '@tb/platform';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AiService } from './service';

const Project = z.object({ projectId: z.uuid() });

/**
 * AI configuration and the case-level AI actions. The configuration is organisation-wide but reached
 * through a project, like the notification console, so the usual project permission check applies;
 * only Org Admins hold ai.configure.
 */
export const aiRoutes: FastifyPluginAsync<ServiceDeps & { ai: AiService }> = async (app, { db, ai }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const caller = (req: { auth: { orgId: string; userId: string } }) => ({
    orgId: req.auth.orgId,
    userId: req.auth.userId,
  });

  r.get('/projects/:projectId/ai/config', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'ai.use', (trx) => ai.view(trx)),
  );

  r.put(
    '/projects/:projectId/ai/config',
    { schema: { params: Project, body: AiConfigBody } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'ai.configure', (trx) =>
        ai.saveConfig(trx, caller(req), req.body),
      );
      return reply.status(204).send();
    },
  );

  r.put(
    '/projects/:projectId/ai/keys/:provider',
    {
      schema: {
        params: Project.extend({ provider: z.enum(['openai', 'anthropic', 'xai']) }),
        body: AiKeyBody,
      },
    },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'ai.configure', (trx) =>
        ai.setKey(trx, caller(req), req.params.provider, req.body.key),
      );
      return reply.status(204).send();
    },
  );

  r.get('/projects/:projectId/ai/usage', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'ai.configure', (trx) => ai.usage(trx)),
  );

  r.post(
    '/projects/:projectId/ai/edge-cases',
    { schema: { params: Project, body: EdgeCasesBody } },
    async (req) => {
      const input = await projectTx(db, req, req.params.projectId, 'ai.use', async (trx) => {
        const c = await trx
          .selectFrom('repo.test_case as c')
          .innerJoin('repo.case_version as v', (j) =>
            j
              .onRef('v.case_id', '=', 'c.id')
              .onRef('v.version', '=', 'c.current_version')
              .onRef('v.project_id', '=', 'c.project_id'),
          )
          .select(['c.title', 'v.preconditions', 'v.steps'])
          .where('c.project_id', '=', req.params.projectId)
          .where('c.key_no', '=', parseCaseKey(req.body.caseKey)!)
          .executeTakeFirst();
        if (!c) throw notFound('Case');
        return {
          title: c.title,
          preconditions: c.preconditions,
          steps: (c.steps as StepJson[]).map((s) => ({ action: s.action, expected: s.expected })),
        };
      });
      return ai.run(caller(req), 'edge_cases', input);
    },
  );
};

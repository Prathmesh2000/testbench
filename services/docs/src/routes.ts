import type { AiService, Caller } from '@tb/ai';
import {
  DocumentBody,
  GenerateCasesBody,
  LinkCasesBody,
  VersionBody,
  type ExtractedRequirement,
} from '@tb/contracts';
import { projectTx } from '@tb/iam';
import { AppError, type ServiceDeps } from '@tb/platform';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addVersion,
  caseFlags,
  compareVersions,
  confirmReview,
  createDocument,
  findRequirement,
  getDocument,
  linkCases,
  linkedCases,
  listDocuments,
  traceability,
  unlinkCase,
  type Extraction,
} from './docs';
import { taggedRequirements } from './requirements';

const Project = z.object({ projectId: z.uuid() });
const Doc = Project.extend({ documentId: z.uuid() });
const Req = Project.extend({ requirementId: z.uuid() });
const CaseKey = Project.extend({ key: z.string().regex(/^TC-\d+$/i) });

/**
 * Requirements from a PRD: its own ids when it has them (no AI needed, ids stable), otherwise an AI
 * extraction. Runs before the database transaction because a local model can take minutes.
 */
async function extract(ai: AiService, caller: Caller, title: string, body: string): Promise<Extraction> {
  const tagged = taggedRequirements(body);
  if (tagged.length) return { requirements: tagged, extractedBy: 'tags' };
  try {
    const answer = await ai.run(caller, 'extract_requirements', { title, body });
    return {
      requirements: uniqueRefs(answer.result.requirements),
      extractedBy: `${answer.provider}:${answer.model}`,
    };
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    throw new AppError(
      422,
      'extraction_failed',
      `This PRD has no requirement ids (such as REQ-AP-01), and AI extraction failed: ${err.message}`,
    );
  }
}

/** Models occasionally repeat an id; the second one gets a fresh number rather than failing the upload. */
function uniqueRefs(list: ExtractedRequirement[]): ExtractedRequirement[] {
  const seen = new Set<string>();
  return list.map((r, i) => {
    const ref = seen.has(r.ref) ? `${r.ref}-${i + 1}` : r.ref;
    seen.add(ref);
    return { ...r, ref };
  });
}

export const docsRoutes: FastifyPluginAsync<ServiceDeps & { ai: AiService }> = async (app, { db, ai }) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const actor = (req: FastifyRequest) => ({ orgId: req.auth.orgId, userId: req.auth.userId });

  r.get('/projects/:projectId/documents', { schema: { params: Project } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', (trx) => listDocuments(trx, req.params.projectId)),
  );

  r.post(
    '/projects/:projectId/documents',
    { schema: { params: Project, body: DocumentBody } },
    async (req, reply) => {
      // Permission first, so nobody without case.write can spend AI tokens.
      await projectTx(db, req, req.params.projectId, 'case.write', async () => undefined);
      const extraction = await extract(ai, actor(req), req.body.title, req.body.body);
      const doc = await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        createDocument(trx, actor(req), req.params.projectId, req.body.title, req.body.body, extraction),
      );
      return reply.status(201).send({ id: doc.id, requirements: extraction.requirements.length });
    },
  );

  r.get(
    '/projects/:projectId/documents/:documentId',
    {
      schema: { params: Doc, querystring: z.object({ version: z.coerce.number().int().min(1).optional() }) },
    },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        getDocument(trx, req.params.projectId, req.params.documentId, req.query.version),
      ),
  );

  r.post(
    '/projects/:projectId/documents/:documentId/versions',
    { schema: { params: Doc, body: VersionBody } },
    async (req, reply) => {
      const title = await projectTx(
        db,
        req,
        req.params.projectId,
        'case.write',
        async (trx) => (await getDocument(trx, req.params.projectId, req.params.documentId)).title,
      );
      const extraction = await extract(ai, actor(req), title, req.body.body);
      const result = await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        addVersion(trx, actor(req), req.params.projectId, req.params.documentId, req.body.body, extraction),
      );
      return reply.status(201).send(result);
    },
  );

  r.get(
    '/projects/:projectId/documents/:documentId/compare',
    {
      schema: {
        params: Doc,
        querystring: z.object({ base: z.coerce.number().int().min(1), head: z.coerce.number().int().min(1) }),
      },
    },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
        compareVersions(trx, req.params.projectId, req.params.documentId, req.query.base, req.query.head),
      ),
  );

  r.get('/projects/:projectId/documents/:documentId/traceability', { schema: { params: Doc } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      traceability(trx, req.params.projectId, req.params.documentId),
    ),
  );

  r.get('/projects/:projectId/requirements/:requirementId/cases', { schema: { params: Req } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      linkedCases(trx, req.params.projectId, req.params.requirementId),
    ),
  );

  r.post(
    '/projects/:projectId/requirements/:requirementId/cases',
    { schema: { params: Req, body: LinkCasesBody } },
    async (req) =>
      projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        linkCases(trx, actor(req), req.params.projectId, req.params.requirementId, req.body.caseKeys),
      ),
  );

  r.delete(
    '/projects/:projectId/requirements/:requirementId/cases/:key',
    { schema: { params: Req.extend({ key: z.string().regex(/^TC-\d+$/i) }) } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        unlinkCase(trx, req.params.projectId, req.params.requirementId, req.params.key),
      );
      return reply.status(204).send();
    },
  );

  // Drafts only: nothing is saved until the tester accepts them and creates the cases.
  r.post(
    '/projects/:projectId/requirements/:requirementId/draft-cases',
    { schema: { params: Req, body: GenerateCasesBody.omit({ requirementId: true }) } },
    async (req) => {
      const input = await projectTx(db, req, req.params.projectId, 'ai.use', async (trx) => {
        const requirement = await findRequirement(trx, req.params.projectId, req.params.requirementId);
        const existing = await linkedCases(trx, req.params.projectId, req.params.requirementId);
        return {
          document: requirement.document,
          requirement: { ref: requirement.ref, title: requirement.title, text: requirement.text },
          count: req.body.count,
          existing: existing.map((c) => c.title),
        };
      });
      return ai.run(actor(req), 'generate_cases', input);
    },
  );

  r.get('/projects/:projectId/cases/:key/flags', { schema: { params: CaseKey } }, async (req) =>
    projectTx(db, req, req.params.projectId, 'case.read', (trx) =>
      caseFlags(trx, req.params.projectId, req.params.key),
    ),
  );

  r.post(
    '/projects/:projectId/cases/:key/confirm-review',
    { schema: { params: CaseKey } },
    async (req, reply) => {
      await projectTx(db, req, req.params.projectId, 'case.write', (trx) =>
        confirmReview(trx, actor(req), req.params.projectId, req.params.key),
      );
      return reply.status(204).send();
    },
  );
};

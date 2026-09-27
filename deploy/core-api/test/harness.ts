import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  JsonCache,
  ObjectStorage,
  createDb,
  createTokenVerifier,
  loadConfig,
  loadEnvFileIfPresent,
  type Database,
  type Db,
} from '@tb/platform';
import type { FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { AiService } from '@tb/ai';
import { JiraClient } from '@tb/defect';
import { CaseIndex, ensurePercolator } from '@tb/search';
import { buildApp } from '../src/app';

// Integration harness: the real app on the local Docker stack (see README), with a locally signed token
// standing in for Keycloak. Each run creates its own organisations, users and project and deletes them
// afterwards, so the tests never touch seeded data and can run against a developer's database.

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const cfg = loadConfig();
const ISSUER = 'https://tests.testbench.local';

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export interface Harness {
  app: FastifyInstance;
  index: CaseIndex;
  jira: JiraClient;
  owner: Kysely<Database>;
  appDb: Db;
  orgId: string;
  otherOrgId: string;
  projectId: string;
  otherProjectId: string;
  moduleIds: { auth: string; upi: string; collect: string };
  users: { admin: TestUser; lead: TestUser; tester: TestUser; viewer: TestUser; outsider: TestUser };
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const verify = createTokenVerifier({
    issuer: ISSUER,
    audience: cfg.OIDC_AUDIENCE,
    keys: createLocalJWKSet({ keys: [jwk] }),
  });
  const sign = (sub: string, email: string) =>
    new SignJWT({ email, name: email.split('@')[0] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(cfg.OIDC_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

  // The owner connection bypasses RLS: it builds fixtures and cleans up. The app itself uses tb_app.
  const owner = new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL, max: 2 }),
    }),
  });
  const appDb = createDb(cfg.DATABASE_URL, 5);
  const cache = JsonCache.connect(cfg.VALKEY_URL, { warn: () => {} });
  const storage = new ObjectStorage({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    accessKeyId: cfg.S3_ACCESS_KEY,
    secretAccessKey: cfg.S3_SECRET_KEY,
    bucket: cfg.S3_BUCKET,
  });
  await storage.ensureBucket();

  const run = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  await owner
    .insertInto('iam.org')
    .values([
      { id: orgId, slug: `ci-${run}`, name: 'CI org' },
      { id: otherOrgId, slug: `ci-other-${run}`, name: 'Another company' },
    ])
    .execute();

  const makeUser = async (role: string, org: string): Promise<TestUser> => {
    const id = randomUUID();
    const email = `${role}.${run}@tests.testbench.local`;
    await owner
      .insertInto('iam.app_user')
      .values({ id, email, name: `${role} ${run}` })
      .execute();
    await owner
      .insertInto('iam.membership')
      .values({ org_id: org, user_id: id, role, project_id: null })
      .execute();
    return { id, email, token: await sign(`sub-${role}-${run}`, email) };
  };
  const users = {
    admin: await makeUser('org_admin', orgId),
    lead: await makeUser('test_lead', orgId),
    tester: await makeUser('tester', orgId),
    viewer: await makeUser('viewer', orgId),
    outsider: await makeUser('project_admin', otherOrgId),
  };

  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  await owner
    .insertInto('repo.project')
    .values([
      { id: projectId, org_id: orgId, key: 'CI', name: 'CI project' },
      { id: otherProjectId, org_id: otherOrgId, key: 'SECRET', name: 'Other company project' },
    ])
    .execute();

  const label = (id: string) => id.replaceAll('-', '');
  const auth = randomUUID();
  const upi = randomUUID();
  const collect = randomUUID();
  const secretModule = randomUUID();
  await owner
    .insertInto('repo.module')
    .values([
      { id: auth, org_id: orgId, project_id: projectId, parent_id: null, name: 'Auth', path: label(auth) },
      { id: upi, org_id: orgId, project_id: projectId, parent_id: null, name: 'UPI', path: label(upi) },
      {
        id: collect,
        org_id: orgId,
        project_id: projectId,
        parent_id: upi,
        name: 'Collect',
        path: `${label(upi)}.${label(collect)}`,
      },
      {
        id: secretModule,
        org_id: otherOrgId,
        project_id: otherProjectId,
        parent_id: null,
        name: 'Secret',
        path: label(secretModule),
      },
    ])
    .execute();

  const index = new CaseIndex(cfg.OPENSEARCH_URL);
  await index.ensure();
  // As in server.ts: otherwise a filter subscription would auto-create this index with the wrong mapping.
  await ensurePercolator(index);
  const jira = new JiraClient({
    baseUrl: cfg.JIRA_BASE_URL!,
    email: cfg.JIRA_EMAIL!,
    apiToken: cfg.JIRA_API_TOKEN!,
    webhookSecret: cfg.JIRA_WEBHOOK_SECRET!,
  });
  const app = await buildApp({
    db: appDb,
    cache,
    storage,
    verify,
    index,
    jira,
    notify: null,
    // Always mock in tests: CI must not depend on a model's speed or randomness (HLD §10.3).
    ai: new AiService(appDb, {
      mode: 'mock',
      ollamaUrl: cfg.OLLAMA_BASE_URL,
      localModel: cfg.AI_LOCAL_MODEL,
      platformKeys: {},
      models: { openai: 'm', anthropic: 'm', xai: 'm' },
      keySecret: 'test-secret-that-is-at-least-32-characters',
    }),
    keycloak: null,
    issuer: ISSUER,
    gatewayUrl: null,
    webUrl: cfg.WEB_URL,
    logLevel: 'silent',
  });

  return {
    app,
    index,
    jira,
    owner,
    appDb,
    orgId,
    otherOrgId,
    projectId,
    otherProjectId,
    moduleIds: { auth, upi, collect },
    users,
    async close() {
      await app.close();
      // Versions are immutable even for the owner, so triggers are switched off for the cleanup only.
      await owner.transaction().execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        for (const table of [
          'audit.entry',
          'iam.token',
          'ai.usage',
          'ai.config',
          'analytics.signoff',
          'docs.case_flag',
          'docs.requirement_case',
          'docs.requirement',
          'docs.document_version',
          'docs.document',
          'outbox.processed',
          'outbox.event',
          'search.filter_subscription',
          'search.saved_filter',
          'defect.event',
          'defect.retest',
          'defect.item_link',
          'defect.sync_state',
          'defect.defect',
          'exec.run_prep',
          'exec.evidence',
          'exec.step_result',
          'exec.run_item',
          'exec.run',
          'repo.bulk_job',
          'repo.module_stats',
          'repo.case_dependency',
          'repo.case_version',
          'repo.test_case',
          'repo.module',
          'repo.project',
          'iam.membership',
          'iam.custom_role',
        ]) {
          await sql`DELETE FROM ${sql.table(table)} WHERE org_id = ANY(${[orgId, otherOrgId]})`.execute(trx);
        }
        await sql`DELETE FROM iam.app_user WHERE email LIKE ${`%.${run}@tests.testbench.local`}`.execute(trx);
        await sql`DELETE FROM iam.org WHERE id = ANY(${[orgId, otherOrgId]})`.execute(trx);
      });
      await cache.close();
      await appDb.destroy();
      await owner.destroy();
    },
  };
}

/** inject() wrapper: JSON in, JSON out, with the caller's bearer token. */
// Defaults to `any` so assertions can reach into responses without a type for every endpoint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call<T = any>(
  h: Harness,
  user: TestUser | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await h.app.inject({
    method,
    url: `/api/v1${url}`,
    payload: body as object | undefined,
    headers: user ? { authorization: `Bearer ${user.token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

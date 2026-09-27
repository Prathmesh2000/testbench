import { fileURLToPath } from 'node:url';
import { AiService } from '@tb/ai';
import { JiraClient, startReconciler } from '@tb/defect';
import { startRunPrepWorker } from '@tb/execution';
import { NotifyClient, notifier } from '@tb/notify-client';
import {
  JsonCache,
  ObjectStorage,
  createDb,
  createTokenVerifier,
  discoverRemoteKeys,
  loadConfig,
  loadEnvFileIfPresent,
  startOutboxRelay,
} from '@tb/platform';
import { startBulkWorker } from '@tb/repository';
import { CaseIndex, caseIndexer, ensurePercolator } from '@tb/search';
import { buildApp } from './app';

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const cfg = loadConfig();

const db = createDb(cfg.DATABASE_URL);
const storage = new ObjectStorage({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  accessKeyId: cfg.S3_ACCESS_KEY,
  secretAccessKey: cfg.S3_SECRET_KEY,
  bucket: cfg.S3_BUCKET,
});
const verify = createTokenVerifier({
  issuer: cfg.OIDC_ISSUER,
  audience: cfg.OIDC_AUDIENCE,
  keys: await discoverRemoteKeys(cfg.OIDC_ISSUER),
});
const index = new CaseIndex(cfg.OPENSEARCH_URL);
const jira =
  cfg.JIRA_BASE_URL && cfg.JIRA_EMAIL && cfg.JIRA_API_TOKEN && cfg.JIRA_WEBHOOK_SECRET
    ? new JiraClient({
        baseUrl: cfg.JIRA_BASE_URL,
        email: cfg.JIRA_EMAIL,
        apiToken: cfg.JIRA_API_TOKEN,
        webhookSecret: cfg.JIRA_WEBHOOK_SECRET,
      })
    : null;

const notify =
  cfg.NOTIFY_URL && cfg.NOTIFY_SERVICE_KEY ? new NotifyClient(cfg.NOTIFY_URL, cfg.NOTIFY_SERVICE_KEY) : null;

const ai = new AiService(db, {
  mode: cfg.AI_MODE,
  ollamaUrl: cfg.OLLAMA_BASE_URL,
  localModel: cfg.AI_LOCAL_MODEL,
  platformKeys: { openai: cfg.OPENAI_API_KEY, anthropic: cfg.ANTHROPIC_API_KEY, xai: cfg.XAI_API_KEY },
  models: { openai: cfg.AI_OPENAI_MODEL, anthropic: cfg.AI_ANTHROPIC_MODEL, xai: cfg.AI_XAI_MODEL },
  keySecret: cfg.AI_KEY_SECRET ?? null,
});

// The cache logs through the app logger once it exists; before that there is nothing to warn about yet.
const cacheLog = { warn: (obj: object, msg: string) => app.log.warn(obj, msg) };
const cache = JsonCache.connect(cfg.VALKEY_URL, cacheLog);
const app = await buildApp({
  db,
  cache,
  storage,
  verify,
  index,
  jira,
  notify,
  ai,
  webUrl: cfg.WEB_URL,
  logLevel: cfg.LOG_LEVEL,
});
if (!jira) app.log.warn('Jira is not configured; defect features are disabled');
if (!notify) app.log.warn('The notification service is not configured; notifications are not sent');
app.log.info({ mode: cfg.AI_MODE, localModel: cfg.AI_LOCAL_MODEL }, 'AI provider layer ready');

await storage.ensureBucket();
await index.ensure();
await ensurePercolator(index);
const stopReconciler = jira
  ? startReconciler(db, jira, app.log, cfg.JIRA_RECONCILE_MINUTES * 60_000)
  : () => {};
const stoppers = [
  startBulkWorker(db, app.log),
  startRunPrepWorker(db, app.log),
  startOutboxRelay(
    db,
    [caseIndexer(index), ...(notify ? [notifier(notify, index, cfg.WEB_URL)] : [])],
    app.log,
  ),
  async () => stopReconciler(),
];

// Graceful shutdown: stop taking requests, let workers finish their current chunk, then close pools.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await Promise.all(stoppers.map((stop) => stop()));
    await cache.close();
    await db.destroy();
    process.exit(0);
  });
}

await app.listen({ port: cfg.CORE_API_PORT, host: '0.0.0.0' });

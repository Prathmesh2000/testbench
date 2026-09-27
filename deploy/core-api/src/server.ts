import { fileURLToPath } from 'node:url';
import {
  JsonCache,
  ObjectStorage,
  createDb,
  createTokenVerifier,
  discoverRemoteKeys,
  loadConfig,
  loadEnvFileIfPresent,
} from '@tb/platform';
import { startBulkWorker } from '@tb/repository';
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

// The cache logs through the app logger once it exists; before that there is nothing to warn about yet.
const cacheLog = { warn: (obj: object, msg: string) => app.log.warn(obj, msg) };
const cache = JsonCache.connect(cfg.VALKEY_URL, cacheLog);
const app = await buildApp({ db, cache, storage, verify, logLevel: cfg.LOG_LEVEL });

await storage.ensureBucket();
const stopWorker = startBulkWorker(db, app.log);

// Graceful shutdown: stop taking requests, let the bulk worker finish its current chunk, then close pools.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await stopWorker();
    await cache.close();
    await db.destroy();
    process.exit(0);
  });
}

await app.listen({ port: cfg.CORE_API_PORT, host: '0.0.0.0' });

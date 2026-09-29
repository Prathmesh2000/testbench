import { fileURLToPath } from 'node:url';
import { ObjectStorage, createDb, loadConfig, loadEnvFileIfPresent } from '@tb/platform';
import { claimItem, runItem } from './worker';

// Headless runner (testing-studio-plan §12). Locally one Node process polling the database queue; in
// AWS the same runItem handler runs in Lambda and ECS Spot behind SQS (technical-design §5.3).

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const cfg = loadConfig();
const CONCURRENCY = Number(process.env.RUNNER_CONCURRENCY ?? 4);

const db = createDb(cfg.DATABASE_URL);
const storage = new ObjectStorage({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  accessKeyId: cfg.S3_ACCESS_KEY,
  secretAccessKey: cfg.S3_SECRET_KEY,
  bucket: cfg.S3_BUCKET,
});

let active = 0;
async function tick() {
  while (active < CONCURRENCY) {
    const claimed = await claimItem(db);
    if (!claimed) return;
    active++;
    void runItem({ db, storage }, claimed)
      .catch((err) => console.error('run item failed', claimed.id, err))
      .finally(() => {
        active--;
      });
  }
}

const timer = setInterval(() => void tick().catch((err) => console.error('runner tick failed', err)), 2_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    await db.destroy();
    process.exit(0);
  });
}
console.log(`Runner started: ${CONCURRENCY} at a time`);

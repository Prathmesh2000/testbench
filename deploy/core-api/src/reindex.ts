import { fileURLToPath } from 'node:url';
import { createDb, loadEnvFileIfPresent } from '@tb/platform';
import { CaseIndex, reindexAll } from '@tb/search';

// Rebuilds the search index from Postgres with no search downtime (new index, then alias swap).
// Run after seeding, after a mapping change, or to recover from a lost index:  pnpm search:reindex
// Uses the owner connection because it reads every tenant; it is an operator tool, not part of the API.

loadEnvFileIfPresent(fileURLToPath(new URL('../../../.env', import.meta.url)));
const ownerUrl = process.env.DATABASE_OWNER_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!ownerUrl || !searchUrl)
  throw new Error('DATABASE_OWNER_URL and OPENSEARCH_URL must be set (see .env.example)');

const db = createDb(ownerUrl, 4);
const started = Date.now();
try {
  const total = await reindexAll(db, new CaseIndex(searchUrl));
  console.log(
    `reindexed ${total.toLocaleString('en-IN')} cases in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} finally {
  await db.destroy();
}

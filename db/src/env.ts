import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Scripts run from the db/ folder but share the repository-root .env with every other app.
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url)
    throw new Error('DATABASE_OWNER_URL is not set. Copy .env.example to .env at the repository root.');
  return url;
}

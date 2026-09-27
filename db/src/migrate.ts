import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import { ownerDatabaseUrl } from './env';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * Serves the plain .sql files in db/migrations to Kysely's migrator, ordered by file name.
 * Migrations are SQL rather than Kysely schema-builder code because RLS policies, partitions, ltree
 * indexes and triggers are clearer (and reviewable by a DBA) in the language they are written in.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const text = await readFile(this.dir + file, 'utf8');
      // Forward-only: rolling back a data migration in production is a new migration, not a down script.
      migrations[file.replace(/\.sql$/, '')] = { up: (db) => sql.raw(text).execute(db) };
    }
    return migrations;
  }
}

async function main(): Promise<void> {
  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: ownerDatabaseUrl(), max: 1 }) }),
  });
  const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(migrationsDir) });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    console.log(`${r.status === 'Success' ? 'applied' : r.status.toLowerCase()}  ${r.migrationName}`);
  }
  if (!results?.length && !error) console.log('database is up to date');
  await db.destroy();
  if (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

await main();

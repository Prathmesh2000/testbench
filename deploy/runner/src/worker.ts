import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_PATH } from '@tb/contracts';
import { devices } from '@playwright/test';
import {
  BROWSER_ARGS,
  BROWSER_LOCALE,
  BROWSER_TIMEZONE,
  desktopUserAgent,
  withTenant,
  type Db,
  type JsonCache,
  type ObjectStorage,
} from '@tb/platform';
import { sql } from 'kysely';
import { LIVE_HOOK, LIVE_HOOK_FILE, LIVE_REPORTER, LIVE_REPORTER_FILE, publishLive } from './live';
import { readReport, type Outcome, type PwReport } from './report';

// One automated run item, end to end: generated spec on disk, a Playwright process, the result and
// evidence written back. Kept free of process-level setup so tests and other entrypoints can drive it.

const TEST_TIMEOUT_MS = 10 * 60_000;
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const WORK = fileURLToPath(new URL('../.work/', import.meta.url));
const CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');

export interface RunnerDeps {
  db: Db;
  storage: ObjectStorage;
  /** Where live frames go; null runs without a live view. */
  cache: JsonCache | null;
}

// RUNNER_HEADED=true (local only) opens a visible browser window for each test, so a developer can
// watch their site being driven. Servers have no display and always run headless. Read per run, not
// at import, because the entrypoint loads .env after this module is imported.
//
// Every test keeps a final screenshot and a trace, pass or fail, so there is always something to look
// at; video costs more, so it is kept only when a test fails. Full Chromium rather than the headless
// shell, as in the Test Browser: bot protection on many public sites refuses the shell outright. The
// browser presents itself as the Test Browser does (browser-profile.ts), so a script recorded there
// meets the same site here.
function configFile(): string {
  const headed = process.env.RUNNER_HEADED === 'true';
  const launch = { args: BROWSER_ARGS, ...(headed ? { slowMo: 250 } : {}) };
  const use = {
    channel: 'chromium',
    headless: !headed,
    userAgent: desktopUserAgent(devices['Desktop Chrome']!.userAgent),
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    launchOptions: launch,
    // A missing element fails its step in a minute, not at the end of the whole test's budget.
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
    trace: 'on',
    screenshot: 'on',
    video: 'retain-on-failure',
  };
  return `export default {
  testDir: '.',
  timeout: ${TEST_TIMEOUT_MS},
  retries: 0,
  workers: 1,
  reporter: [['json', { outputFile: 'report.json' }], ['./${LIVE_REPORTER_FILE}']],
  outputDir: 'out',
  use: ${JSON.stringify(use)},
};
`;
}

/**
 * The test process gets only what a browser needs plus its inputs: never this runner's database,
 * storage or API credentials, even though today's generated code cannot read them.
 */
function testEnv(data: Record<string, string>, env: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'PLAYWRIGHT_BROWSERS_PATH'];
  const base = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  // Until runs get a secret store, a test's secrets come from TB_SECRET_<name> on the runner.
  const secrets = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('TB_SECRET_')));
  return { ...base, ...secrets, CI: '1', TB_DATA: JSON.stringify(data), TB_ENV: JSON.stringify(env) };
}

function runPlaywright(dir: string, env: NodeJS.ProcessEnv, spec: string | null): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, 'test', '--config', join(dir, 'playwright.config.mjs'), ...(spec ? [spec] : [])],
      { cwd: dir, env, timeout: TEST_TIMEOUT_MS + 60_000, maxBuffer: 10 * 1024 * 1024 },
      (_err, _stdout, stderr) => resolve(stderr),
    );
  });
}

const KIND: Record<string, 'trace' | 'screenshot' | 'video'> = { trace: 'trace', screenshot: 'screenshot', video: 'video' };

/**
 * Writes a frozen workspace to disk. Paths were validated when saved; they are checked again here
 * because this is where a bad one would turn into a file outside the working directory.
 */
async function writeWorkspace(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(dir, path);
    if (!CODE_PATH.test(path) || !target.startsWith(resolve(dir) + sep)) throw new Error(`Refusing workspace path ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** Claims the next item any organisation has waiting, respecting each run's parallel limit. */
export async function claimItem(db: Db): Promise<{ id: string; org_id: string } | null> {
  const { rows } = await sql<{ id: string; org_id: string }>`SELECT * FROM studio.claim_run_item()`.execute(db);
  return rows[0] ?? null;
}

export async function runItem({ db, storage, cache }: RunnerDeps, claimed: { id: string; org_id: string }): Promise<void> {
  const actor = { orgId: claimed.org_id, userId: SYSTEM_USER };
  const job = await withTenant(db, actor, async (trx) => {
    const row = await trx
      .selectFrom('studio.auto_run_item as i')
      .innerJoin('studio.auto_run as r', 'r.id', 'i.run_id')
      .select([
        'i.id',
        'i.run_id',
        'i.code',
        'i.spec_path',
        'i.data',
        'i.attempt',
        'r.base_url',
        'r.variables',
        'r.workspace',
        'r.status as run_status',
      ])
      .where('i.id', '=', claimed.id)
      .executeTakeFirstOrThrow();
    if (row.run_status === 'queued')
      await trx.updateTable('studio.auto_run').set({ status: 'running' }).where('id', '=', row.run_id).execute();
    return row;
  });

  const dir = join(WORK, `${job.id}-${job.attempt}`);
  let outcome: Outcome;
  try {
    await mkdir(dir, { recursive: true });
    // CommonJS lets specs import their page objects without file extensions, as Playwright projects do.
    await writeFile(join(dir, 'package.json'), '{ "private": true, "type": "commonjs" }\n');
    await writeFile(join(dir, 'playwright.config.mjs'), configFile());
    await writeFile(join(dir, LIVE_REPORTER_FILE), LIVE_REPORTER);
    if (job.spec_path) await writeWorkspace(dir, job.workspace ?? {});
    else {
      // Generated specs show their page live; a workspace spec is the team's own code and is left as written.
      await writeFile(join(dir, LIVE_HOOK_FILE), LIVE_HOOK);
      await writeFile(join(dir, 'test.spec.ts'), `import './tb-live';\n${job.code}`);
    }
    const stopLive = publishLive({ dir, itemId: job.id, cache });
    const stderr = await runPlaywright(dir, testEnv(job.data, { ...job.variables, baseUrl: job.base_url }), job.spec_path).finally(stopLive);
    const report = await readFile(join(dir, 'report.json'), 'utf8').then(
      (t) => JSON.parse(t) as PwReport,
      () => null,
    );
    outcome = report
      ? readReport(report)
      : { status: 'error', error: stderr.slice(-2_000) || 'Playwright produced no report', durationMs: 0, steps: [], attachments: [] };

    const evidence = [];
    for (const a of outcome.attachments) {
      const kind = KIND[a.name];
      if (!kind) continue;
      const bytes = await readFile(a.path);
      const key = `${claimed.org_id}/studio/${job.run_id}/${job.id}/${job.attempt}-${basename(a.path)}`;
      await storage.write(key, bytes, a.contentType);
      evidence.push({ kind, key, fileName: basename(a.path), contentType: a.contentType, sizeBytes: (await stat(a.path)).size });
    }
    await record(db, actor, job, outcome, evidence);
  } catch (err) {
    outcome = { status: 'error', error: err instanceof Error ? err.message : String(err), durationMs: 0, steps: [], attachments: [] };
    await record(db, actor, job, outcome, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Writes the result. A first failure goes back in the queue once; a pass on that retry counts as
 * flaky (§5.1), and the first attempt's evidence is kept alongside the second's.
 */
async function record(
  db: Db,
  actor: { orgId: string; userId: string },
  job: { id: string; run_id: string; attempt: number },
  outcome: Outcome,
  evidence: object[],
) {
  await withTenant(db, actor, async (trx) => {
    const retry = outcome.status === 'failed' && job.attempt === 1;
    await trx
      .updateTable('studio.auto_run_item')
      .set((eb) => ({
        status: retry ? 'queued' : outcome.status,
        flaky: outcome.status === 'passed' && job.attempt > 1,
        error: outcome.error,
        steps: JSON.stringify(outcome.steps),
        evidence: sql`evidence || ${JSON.stringify(evidence)}::jsonb`,
        duration_ms: outcome.durationMs,
        finished_at: retry ? null : new Date(),
        updated_at: eb.val(new Date()),
      }))
      .where('id', '=', job.id)
      .execute();
    const open = await trx
      .selectFrom('studio.auto_run_item')
      .select('id')
      .where('run_id', '=', job.run_id)
      .where('status', 'in', ['queued', 'running'])
      .limit(1)
      .executeTakeFirst();
    if (!open)
      await trx
        .updateTable('studio.auto_run')
        .set({ status: 'done', finished_at: new Date() })
        .where('id', '=', job.run_id)
        .where('status', '=', 'running')
        .execute();
  });
}


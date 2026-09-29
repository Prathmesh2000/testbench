import { CODE_PATH, type CodeDiagnostic, type CodeFile, type CodeFileSummary, type SavedCodeFile } from '@tb/contracts';
import { AppError, badRequest, notFound, type Tx } from '@tb/platform';
import ts from 'typescript';

type Caller = { orgId: string; userId: string };

/**
 * Syntax problems only (a missing bracket, a stray token): enough to catch a broken save at once
 * without type-checking against Playwright's types on the server. Type errors surface when it runs.
 */
export function diagnose(path: string, content: string): CodeDiagnostic[] {
  if (path.endsWith('.json')) {
    try {
      JSON.parse(content);
      return [];
    } catch (err) {
      return [{ line: 1, column: 1, message: err instanceof Error ? err.message : 'Invalid JSON' }];
    }
  }
  const out = ts.transpileModule(content, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) => {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    return { line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') };
  });
}

const summary = (r: { path: string; version: number; updated_at: Date; name: string }): CodeFileSummary => ({
  path: r.path,
  version: r.version,
  updatedAt: r.updated_at.toISOString(),
  updatedBy: r.name,
});

function files(trx: Tx, projectId: string) {
  return trx
    .selectFrom('studio.code_file as f')
    .innerJoin('iam.app_user as u', 'u.id', 'f.updated_by')
    .select(['f.id', 'f.path', 'f.content', 'f.version', 'f.updated_at', 'u.name'])
    .where('f.project_id', '=', projectId);
}

export async function listFiles(trx: Tx, projectId: string): Promise<CodeFileSummary[]> {
  return (await files(trx, projectId).orderBy('f.path').execute()).map(summary);
}

export async function getFile(trx: Tx, projectId: string, path: string): Promise<CodeFile> {
  const f = await files(trx, projectId).where('f.path', '=', path).executeTakeFirst();
  if (!f) throw notFound('File');
  return { ...summary(f), content: f.content };
}

/** Every file's content, frozen into a run so all its items execute the same framework. */
export async function snapshot(trx: Tx, projectId: string): Promise<Record<string, string>> {
  const rows = await trx.selectFrom('studio.code_file').select(['path', 'content']).where('project_id', '=', projectId).execute();
  return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}

/**
 * Saves a file, keeping the previous content as a version. A save based on an older version than
 * the one stored is refused, so two people editing the same page object can't overwrite each other.
 * Syntax problems are reported but don't block the save: work in progress is allowed.
 */
export async function saveFile(
  trx: Tx,
  caller: Caller,
  projectId: string,
  body: { path: string; content: string; baseVersion?: number },
): Promise<SavedCodeFile> {
  if (!CODE_PATH.test(body.path)) throw badRequest('That path is not allowed in the workspace.');
  const current = await trx
    .selectFrom('studio.code_file')
    .select(['id', 'version'])
    .where('project_id', '=', projectId)
    .where('path', '=', body.path)
    .forUpdate()
    .executeTakeFirst();
  if (current && body.baseVersion !== undefined && body.baseVersion !== current.version)
    throw new AppError(409, 'edit_conflict', `Someone saved ${body.path} after you opened it. Reload it to see their changes.`);

  let id: string;
  let version: number;
  if (current) {
    const row = await trx
      .updateTable('studio.code_file')
      .set({ content: body.content, version: current.version + 1, updated_by: caller.userId, updated_at: new Date() })
      .where('id', '=', current.id)
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    ({ id, version } = row);
  } else {
    const row = await trx
      .insertInto('studio.code_file')
      .values({ org_id: caller.orgId, project_id: projectId, path: body.path, content: body.content, updated_by: caller.userId })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    ({ id, version } = row);
  }
  await trx
    .insertInto('studio.code_file_version')
    .values({ file_id: id, version, org_id: caller.orgId, content: body.content, created_by: caller.userId })
    .execute();
  return { file: await getFile(trx, projectId, body.path), diagnostics: diagnose(body.path, body.content) };
}

export async function deleteFile(trx: Tx, projectId: string, path: string): Promise<void> {
  const gone = await trx
    .deleteFrom('studio.code_file')
    .where('project_id', '=', projectId)
    .where('path', '=', path)
    .returning('id')
    .executeTakeFirst();
  if (!gone) throw notFound('File');
}

// ---------- starter framework ----------

/**
 * A small, conventional Playwright framework to start from: page objects, fixtures that hand them to
 * specs, helpers for the values Testbench passes in, and an example spec. Only files that don't exist
 * yet are added, so it never overwrites work.
 */
export const STARTER: Record<string, string> = {
  'utils/env.ts': `// Values Testbench passes to every run: the environment under test, the data row and secrets.
export const env: Record<string, string> = JSON.parse(process.env.TB_ENV ?? '{}');
export const data: Record<string, string> = JSON.parse(process.env.TB_DATA ?? '{}');
export const secret = (name: string) => process.env[\`TB_SECRET_\${name}\`] ?? '';

/** An address on the environment under test, e.g. url('/login'). */
export const url = (path = '/') => \`\${env.baseUrl ?? ''}\${path}\`;
`,
  'pages/LoginPage.ts': `import type { Locator, Page } from '@playwright/test';
import { url } from '../utils/env';

/** Page object: locators live here once, so a UI change is fixed in one place. */
export class LoginPage {
  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;

  constructor(readonly page: Page) {
    this.email = page.getByLabel('Email');
    this.password = page.getByLabel('Password');
    this.submit = page.getByRole('button', { name: 'Sign in' });
  }

  async open() {
    await this.page.goto(url('/login'));
  }

  async signIn(email: string, password: string) {
    await this.email.fill(email);
    await this.password.fill(password);
    await this.submit.click();
  }
}
`,
  'fixtures/index.ts': `import { test as base, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';

// Page objects as fixtures: a spec asks for \`loginPage\` and gets one bound to its own page.
type Pages = {
  loginPage: LoginPage;
};

export const test = base.extend<Pages>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
});

export { expect };
`,
  'utils/wait.ts': `import { expect, type Locator, type Page, type Response } from '@playwright/test';

// Waiting, done the way that does not create flaky tests.
//
// There is no sleep() here on purpose. A fixed wait is either too short (fails on a slow day) or too
// long (every run pays for it). Playwright already waits for an element to exist, be visible and be
// stable before acting, and every expect() below retries until it passes or times out. Reach for
// these only when you need to wait for something Playwright cannot see by itself.

/** Waits until the page settles on a URL, e.g. after a redirect: await onPage(page, /dashboard/). */
export async function onPage(page: Page, url: string | RegExp) {
  await page.waitForURL(url);
}

/**
 * Waits for the request the page makes in the background, so the next step reads saved data rather
 * than a half-drawn screen:
 *   const saved = clickAndWaitFor(page, /\/api\/cart/, () => page.getByRole('button', { name: 'Add' }).click());
 */
export async function clickAndWaitFor(page: Page, url: string | RegExp, action: () => Promise<void>): Promise<Response> {
  const [response] = await Promise.all([page.waitForResponse(url), action()]);
  return response;
}

/** Waits for a spinner or skeleton to go away before reading the screen. */
export async function gone(locator: Locator, timeoutMs = 30_000) {
  await expect(locator).toBeHidden({ timeout: timeoutMs });
}

/** For the rare slow screen: the same check as always, with more patience just this once. */
export async function eventually(locator: Locator, timeoutMs = 60_000) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
}
`,
  'utils/testdata.ts': `import { data } from './env';

// Test data that is safe to run again tomorrow.
//
// Two rules worth knowing. Anything unique (an email, a phone, an order reference) must differ every
// run, or the second run fails on "already exists". And nothing here touches real customer data:
// these are made-up values shaped like the real thing.

/** Different on every run and every parallel worker, so two runs never collide. */
const runStamp = process.env.TB_RUN_STAMP ?? String(Date.now());
let counter = 0;
const unique = () => runStamp + '-' + ++counter;

/** qa+testbench-1790000000000-1@example.com */
export const uniqueEmail = (prefix = 'qa') => prefix + '+testbench-' + unique() + '@example.com';

/** A number in the Indian mobile range; not a real subscriber. */
export const mobile = () => '9' + String(Math.floor(Math.random() * 9e8) + 1e8);

const FIRST = ['Aarav', 'Riya', 'Vihaan', 'Ananya', 'Kabir', 'Meera', 'Arjun', 'Sneha', 'Rohan', 'Priya'];
const LAST = ['Sharma', 'Iyer', 'Patil', 'Reddy', 'Nair', 'Gupta', 'Bose', 'Menon', 'Desai', 'Rao'];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;

export const fullName = () => pick(FIRST) + ' ' + pick(LAST);

/** A PIN code in a real range; pair it with the city your app expects. */
export const pincode = () => String(Math.floor(Math.random() * 8e5) + 110001);

/** Amount in paise, which is how most Indian payment APIs take it. */
export const paise = (rupees: number) => Math.round(rupees * 100);

/** Today shifted by whole days: dayOffset(-30) for a month ago. ISO date, no time. */
export const dayOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * A value from the run's data set with a fallback, so a spec still works when it is run on its own:
 *   const email = fromRow('email', uniqueEmail());
 */
export const fromRow = (column: string, fallback: string) => data[column] ?? fallback;

/** Values worth trying when you want a field to reject something. */
export const BAD_INPUT = {
  empty: '',
  spaces: '   ',
  tooLong: 'x'.repeat(500),
  unicode: 'नमस्ते 🙏 مرحبا',
  apostrophe: "O'Brien",
  doubleQuotes: 'she said "no"',
  htmlish: '<script>alert(1)</script>',
  sqlish: "1' OR '1'='1",
};
`,
  'tests/example.spec.ts': `import { expect, test } from '../fixtures';
import { url } from '../utils/env';

test('home page loads', async ({ page }) => {
  await page.goto(url('/'));
  await expect(page).toHaveTitle(/.+/);
});

// Using a page object through its fixture:
// test('customer can sign in', async ({ loginPage, page }) => {
//   await loginPage.open();
//   await loginPage.signIn(data.email, secret('password'));
//   await expect(page).toHaveURL(/dashboard/);
// });
`,
};

export async function createStarter(trx: Tx, caller: Caller, projectId: string): Promise<CodeFileSummary[]> {
  const existing = new Set((await listFiles(trx, projectId)).map((f) => f.path));
  for (const [path, content] of Object.entries(STARTER))
    if (!existing.has(path)) await saveFile(trx, caller, projectId, { path, content });
  return listFiles(trx, projectId);
}

/** Every file with its content: the editor loads the whole workspace so imports between files resolve. */
export async function allFiles(trx: Tx, projectId: string): Promise<CodeFile[]> {
  return (await files(trx, projectId).orderBy('f.path').execute()).map((f) => ({ ...summary(f), content: f.content }));
}

/** Moves a file to a new path (a rename, or into another folder), keeping its history. */
export async function renameFile(trx: Tx, caller: Caller, projectId: string, from: string, to: string): Promise<CodeFile> {
  if (!CODE_PATH.test(to)) throw badRequest('Put files in pages/, fixtures/, utils/, tests/ or data/, ending in .ts or .json.');
  const taken = await trx
    .selectFrom('studio.code_file')
    .select('id')
    .where('project_id', '=', projectId)
    .where('path', '=', to)
    .executeTakeFirst();
  if (taken) throw new AppError(409, 'conflict', `${to} already exists.`);
  const moved = await trx
    .updateTable('studio.code_file')
    .set({ path: to, updated_by: caller.userId, updated_at: new Date() })
    .where('project_id', '=', projectId)
    .where('path', '=', from)
    .returning('id')
    .executeTakeFirst();
  if (!moved) throw notFound('File');
  return getFile(trx, projectId, to);
}

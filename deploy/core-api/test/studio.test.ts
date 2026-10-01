import type {
  AutoRun,
  AutoRunDetail,
  CodeFile,
  CodeFileSummary,
  GeneratedCode,
  PageElement,
  SavedCodeFile,
  StudioTest,
} from '@tb/contracts';
import { claimItem, runItem } from '@tb/runner/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, startHarness, type Harness } from './harness';

// Testing Studio against the local stack: steps saved and validated, code generated, and the generated
// test run headless by the real runner against the Jira sandbox page (a stable local web page).

let h: Harness;
const SITE = 'http://localhost:8090';

beforeAll(async () => {
  h = await startHarness();
}, 30_000);
afterAll(async () => {
  await h?.close();
});

const base = () => `/projects/${h.projectId}/studio`;

/**
 * Drives the runner until this run has nothing queued or running. A developer's own runner may be
 * running against the same database and claim items first, so a turn that claims nothing waits
 * before looking again instead of spinning.
 */
async function drain(runId: string) {
  for (let i = 0; i < 60; i++) {
    const claimed = await claimItem(h.appDb);
    if (claimed) await runItem({ db: h.appDb, storage: h.storage, cache: null }, claimed);
    else await new Promise((r) => setTimeout(r, 2_000));
    const run = await call<AutoRunDetail>(h, h.users.lead, 'GET', `${base()}/runs/${runId}`);
    if (run.body.status !== 'queued' && run.body.status !== 'running') return run.body;
  }
  throw new Error('run did not finish');
}

describe('Testing Studio', () => {
  let heading: PageElement;
  let good: StudioTest;
  let bad: StudioTest;

  it('keeps elements in the page library', async () => {
    const res = await call<PageElement>(h, h.users.tester, 'PUT', `${base()}/elements`, {
      page: 'Sandbox home',
      name: 'Page heading',
      locators: [{ strategy: 'role', value: 'heading', name: 'Jira sandbox' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    heading = res.body;
  });

  it('refuses steps that break the reliability rules, listing every problem', async () => {
    const res = await call(h, h.users.tester, 'POST', `${base()}/tests`, {
      title: 'Broken test',
      steps: [
        { id: 'a', action: 'open', value: '{env.baseUrl}/' },
        { id: 'b', action: 'type', target: { locator: { strategy: 'label', value: 'Email' } }, value: '{data.email}' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(['needs_assertion', 'unknown_data']),
    );
  });

  it('saves a test as versioned steps and generates its Playwright code', async () => {
    const steps = [
      { id: 'a', action: 'open', value: '{env.baseUrl}/', intent: 'Open the sandbox', assertions: [{ kind: 'title_contains', expected: 'Jira sandbox' }] },
      { id: 'b', action: 'verify', target: { elementId: heading.id }, intent: 'See the heading', assertions: [{ kind: 'visible' }, { kind: 'text_contains', expected: 'sandbox' }] },
    ];
    const res = await call<StudioTest>(h, h.users.tester, 'POST', `${base()}/tests`, { title: 'Sandbox loads', steps });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    good = res.body;
    expect(good).toMatchObject({ key: expect.stringMatching(/^AT-\d+$/), version: 1, status: 'draft' });

    const edited = await call<StudioTest>(h, h.users.tester, 'PUT', `${base()}/tests/${good.id}`, { title: 'Sandbox loads', steps });
    expect(edited.body.version).toBe(2);
    const v1 = await call<StudioTest>(h, h.users.tester, 'GET', `${base()}/tests/${good.id}?version=1`);
    expect(v1.body.version).toBe(1);

    const code = await call<GeneratedCode>(h, h.users.tester, 'GET', `${base()}/tests/${good.id}/code`);
    expect(code.body.runnable).toBe(true);
    expect(code.body.code).toContain('page.getByRole(role("heading"), { name: "Jira sandbox", exact: true })');

    const failing = await call<StudioTest>(h, h.users.tester, 'POST', `${base()}/tests`, {
      title: 'Sandbox shows the wrong heading',
      steps: [{ id: 'a', action: 'open', value: '{env.baseUrl}/', assertions: [{ kind: 'title_contains', expected: 'Not this title' }] }],
    });
    bad = failing.body;
  });

  it('runs tests headless, retries a failure once and keeps traces as evidence', async () => {
    const started = await call<AutoRun>(h, h.users.lead, 'POST', `${base()}/runs`, {
      name: 'Smoke',
      testIds: [good.id, bad.id],
      baseUrl: SITE,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.counts).toMatchObject({ total: 2, queued: 2 });

    const run = await drain(started.body.id);
    expect(run.status).toBe('done');
    const passed = run.items.find((i) => i.testId === good.id)!;
    const failed = run.items.find((i) => i.testId === bad.id)!;
    expect(passed, JSON.stringify(passed)).toMatchObject({ status: 'passed', flaky: false, attempt: 1 });
    expect(passed.steps.map((s) => s.title)).toEqual(['1. Open the sandbox', '2. See the heading']);
    expect(passed.evidence.map((e) => e.kind)).toContain('trace');
    expect(failed).toMatchObject({ status: 'failed', attempt: 2 });
    expect(failed.error).toContain('Not this title');
  }, 180_000);

  it('creates a starter Playwright framework and reports syntax problems on save', async () => {
    const starter = await call<CodeFileSummary[]>(h, h.users.tester, 'POST', `${base()}/code/starter`);
    expect(starter.body.map((f) => f.path)).toEqual(
      expect.arrayContaining(['fixtures/index.ts', 'pages/LoginPage.ts', 'tests/example.spec.ts', 'utils/env.ts']),
    );
    const broken = await call<SavedCodeFile>(h, h.users.tester, 'PUT', `${base()}/code/file`, {
      path: 'utils/broken.ts',
      content: 'export const x = (1;\n',
    });
    expect(broken.status).toBe(200);
    expect(broken.body.diagnostics[0]).toMatchObject({ line: 1 });
    const escape = await call(h, h.users.tester, 'PUT', `${base()}/code/file`, { path: '../etc/passwd.ts', content: '' });
    expect(escape.status).toBe(400);
    await call(h, h.users.tester, 'DELETE', `${base()}/code/file?path=utils/broken.ts`);
  });

  it('refuses a save over someone else’s newer edit', async () => {
    const first = await call<SavedCodeFile>(h, h.users.tester, 'PUT', `${base()}/code/file`, {
      path: 'pages/SandboxPage.ts',
      content: [
        "import type { Page } from '@playwright/test';",
        "import { url } from '../utils/env';",
        '',
        'export class SandboxPage {',
        '  constructor(readonly page: Page) {}',
        "  heading = () => this.page.getByRole('heading', { name: 'Jira sandbox' });",
        '  async open() {',
        "    await this.page.goto(url('/'));",
        '  }',
        '}',
        '',
      ].join('\n'),
    });
    expect(first.body.file.version).toBe(1);
    const stale = await call(h, h.users.lead, 'PUT', `${base()}/code/file`, { path: 'pages/SandboxPage.ts', content: '// mine', baseVersion: 0 });
    expect(stale.status).toBe(409);
  });

  it('runs a hand-written spec with page objects from the workspace', async () => {
    await call(h, h.users.tester, 'PUT', `${base()}/code/file`, {
      path: 'tests/sandbox.spec.ts',
      content: [
        "import { expect, test } from '../fixtures';",
        "import { SandboxPage } from '../pages/SandboxPage';",
        "import { url } from '../utils/env';",
        '',
        "test('sandbox title', async ({ page }) => {",
        "  await page.goto(url('/'));",
        '  await expect(page).toHaveTitle(/Jira sandbox/);',
        '});',
        '',
        "test('heading through the page object', async ({ page }) => {",
        '  const sandbox = new SandboxPage(page);',
        '  await sandbox.open();',
        '  await expect(sandbox.heading()).toBeVisible();',
        '});',
        '',
      ].join('\n'),
    });
    const started = await call<AutoRun>(h, h.users.lead, 'POST', `${base()}/runs`, {
      name: 'Code smoke',
      specPaths: ['tests/sandbox.spec.ts'],
      baseUrl: SITE,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const run = await drain(started.body.id);
    const item = run.items[0]!;
    expect(item, JSON.stringify(item)).toMatchObject({ specPath: 'tests/sandbox.spec.ts', status: 'passed', testId: null });
    expect(item.steps.map((s) => s.title)).toEqual(['sandbox title', 'heading through the page object']);
  }, 180_000);

  it('converts a step test into a spec file, one way', async () => {
    const res = await call<{ path: string }>(h, h.users.tester, 'POST', `${base()}/tests/${good.id}/eject`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const file = await call<CodeFile>(h, h.users.tester, 'GET', `${base()}/code/file?path=${res.body.path}`);
    expect(file.body.content).toContain("import { expect, test, type Locator, type Page } from '@playwright/test';");
    const after = await call<StudioTest>(h, h.users.tester, 'GET', `${base()}/tests/${good.id}`);
    expect(after.body.status).toBe('archived');
  });

  it('lets testers save tests but only leads start runs', async () => {
    const res = await call(h, h.users.tester, 'POST', `${base()}/runs`, { name: 'x', testIds: [good.id], baseUrl: SITE });
    expect(res.status).toBe(403);
  });
});

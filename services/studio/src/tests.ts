import type {
  GeneratedCode,
  Locator,
  PageElement,
  SaveComponentBody,
  SaveTestBody,
  AutoStep,
  StepIssue,
  StudioComponent,
  StudioTest,
  TestIntent,
} from '@tb/contracts';
import { ComponentMeta } from '@tb/contracts';
import { badRequest, conflict, notFound, recordEvent, type Tx } from '@tb/platform';
import { saveFile } from './code';
import type { z } from 'zod';
import { generateCode, type GenerationLibrary } from './generate';
import { validateSteps, type ValidationContext } from './validate';

type Caller = { orgId: string; userId: string };
export const testKey = (n: number) => `AT-${n}`;

/** Refuses the save with every error at once, so the tester fixes them in one pass. */
function assertValid(issues: StepIssue[]): StepIssue[] {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length)
    throw badRequest(
      `${errors.length} step problem${errors.length === 1 ? '' : 's'} to fix before saving: ${errors[0]!.message}`,
      errors,
    );
  return issues.filter((i) => i.severity === 'warning');
}

/** Components referenced anywhere in the steps, keyed `${id}@${version}`. */
async function componentsFor(trx: Tx, projectId: string, steps: AutoStep[]) {
  const refs = steps.flatMap((s) => (s.component ? [s.component] : []));
  const found = new Map<string, { name: string; steps: AutoStep[]; inputs: string[] }>();
  if (!refs.length) return found;
  const rows = await trx
    .selectFrom('studio.component_version as v')
    .innerJoin('studio.component as c', 'c.id', 'v.component_id')
    .select(['v.component_id', 'v.version', 'v.steps', 'v.inputs', 'c.name'])
    .where('c.project_id', '=', projectId)
    .where('v.component_id', 'in', [...new Set(refs.map((r) => r.id))])
    .execute();
  for (const r of rows)
    found.set(`${r.component_id}@${r.version}`, { name: r.name, steps: r.steps as AutoStep[], inputs: r.inputs });
  return found;
}

async function elementMap(trx: Tx, projectId: string): Promise<Map<string, Locator[]>> {
  const rows = await trx
    .selectFrom('studio.page_element')
    .select(['id', 'locators'])
    .where('project_id', '=', projectId)
    .execute();
  return new Map(rows.map((r) => [r.id, r.locators as Locator[]]));
}

async function contextFor(
  trx: Tx,
  projectId: string,
  body: { dataSetId: string | null; secrets: string[]; steps: AutoStep[] },
): Promise<{ ctx: ValidationContext; lib: GenerationLibrary }> {
  const [elements, components, dataSet] = await Promise.all([
    elementMap(trx, projectId),
    componentsFor(trx, projectId, body.steps),
    body.dataSetId
      ? trx
          .selectFrom('repo.data_set')
          .select('columns')
          .where('id', '=', body.dataSetId)
          .where('project_id', '=', projectId)
          .executeTakeFirst()
      : Promise.resolve(null),
  ]);
  if (body.dataSetId && !dataSet) throw badRequest('That data set is not in this project.');
  return {
    ctx: {
      dataColumns: dataSet?.columns ?? null,
      secrets: body.secrets,
      elementIds: new Set(elements.keys()),
      components,
    },
    lib: { elements, components },
  };
}

async function testView(trx: Tx, projectId: string, testId: string, version?: number): Promise<StudioTest> {
  const t = await trx
    .selectFrom('studio.test')
    .selectAll()
    .where('id', '=', testId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!t) throw notFound('Test');
  const v = await trx
    .selectFrom('studio.test_version')
    .selectAll()
    .where('test_id', '=', testId)
    .where('version', '=', version ?? t.current_version)
    .executeTakeFirst();
  if (!v) throw notFound('Test version');
  return {
    id: t.id,
    key: testKey(t.key_no),
    title: t.title,
    kind: t.kind as StudioTest['kind'],
    status: t.status as StudioTest['status'],
    caseId: t.case_id,
    dataSetId: t.data_set_id,
    version: v.version,
    secrets: v.secrets,
    steps: v.steps as AutoStep[],
    warnings: v.warnings as StepIssue[],
    intent: (t.intent as TestIntent | null) ?? null,
    updatedAt: t.updated_at.toISOString(),
  };
}

export async function listTests(trx: Tx, projectId: string) {
  const rows = await trx
    .selectFrom('studio.test')
    .select(['id', 'key_no', 'title', 'kind', 'status', 'case_id', 'current_version', 'updated_at'])
    .where('project_id', '=', projectId)
    .where('status', '!=', 'archived')
    .orderBy('key_no', 'desc')
    .limit(500)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    key: testKey(r.key_no),
    title: r.title,
    kind: r.kind,
    status: r.status,
    caseId: r.case_id,
    version: r.current_version,
    updatedAt: r.updated_at.toISOString(),
  }));
}

export const getTest = testView;

/**
 * Saves a test: a new test, or a new immutable version of an existing one. Every edit goes back to
 * draft, because the quality gate and review (§5.1) approved the old steps, not these.
 */
export async function saveTest(
  trx: Tx,
  caller: Caller,
  projectId: string,
  body: z.infer<typeof SaveTestBody>,
  testId?: string,
): Promise<StudioTest> {
  const { ctx } = await contextFor(trx, projectId, body);
  const warnings = assertValid(validateSteps(body.steps, ctx));

  let id = testId;
  let version = 1;
  if (!id) {
    // Lock the project row so two saves can't take the same AT- number.
    await trx.selectFrom('repo.project').select('id').where('id', '=', projectId).forUpdate().executeTakeFirstOrThrow();
    const last = await trx
      .selectFrom('studio.test')
      .select((eb) => eb.fn.max('key_no').as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    const created = await trx
      .insertInto('studio.test')
      .values({
        org_id: caller.orgId,
        project_id: projectId,
        key_no: Number(last?.n ?? 0) + 1,
        title: body.title,
        kind: body.kind,
        case_id: body.caseId,
        data_set_id: body.dataSetId,
        owner_id: caller.userId,
        intent: body.intent ? JSON.stringify(body.intent) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = created.id;
  } else {
    const current = await trx
      .updateTable('studio.test')
      .set((eb) => ({
        title: body.title,
        kind: body.kind,
        case_id: body.caseId,
        data_set_id: body.dataSetId,
        // An ordinary edit sends no intent; it keeps the one the test was built from.
        ...(body.intent ? { intent: JSON.stringify(body.intent) } : {}),
        status: 'draft',
        current_version: eb('current_version', '+', 1),
        updated_at: new Date(),
      }))
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .returning('current_version')
      .executeTakeFirst();
    if (!current) throw notFound('Test');
    version = current.current_version;
  }
  await trx
    .insertInto('studio.test_version')
    .values({
      test_id: id,
      version,
      org_id: caller.orgId,
      steps: JSON.stringify(body.steps),
      secrets: body.secrets,
      warnings: JSON.stringify(warnings),
      created_by: caller.userId,
    })
    .execute();
  await recordEvent(trx, {
    type: 'studio.test.saved',
    orgId: caller.orgId,
    projectId,
    actor: caller.userId,
    data: { test_id: id, version, warnings: warnings.length },
  });
  return testView(trx, projectId, id, version);
}

/** The Playwright code a version turns into; also what the runner executes. */
export async function testCode(trx: Tx, projectId: string, testId: string, version?: number): Promise<GeneratedCode> {
  const t = await testView(trx, projectId, testId, version);
  const { lib } = await contextFor(trx, projectId, t);
  return generateCode({ title: t.title, key: t.key, version: t.version, steps: t.steps }, lib);
}

// ---------- page library ----------

const elementView = (r: { id: string; page: string; name: string; locators: unknown; updated_at: Date }): PageElement => ({
  id: r.id,
  page: r.page,
  name: r.name,
  locators: r.locators as Locator[],
  updatedAt: r.updated_at.toISOString(),
});

export async function listElements(trx: Tx, projectId: string): Promise<PageElement[]> {
  const rows = await trx
    .selectFrom('studio.page_element')
    .selectAll()
    .where('project_id', '=', projectId)
    .orderBy('page')
    .orderBy('name')
    .execute();
  return rows.map(elementView);
}

/** Creates or updates an element by page + name; updating its locators repairs every test using it. */
export async function saveElement(
  trx: Tx,
  caller: Caller,
  projectId: string,
  body: { page: string; name: string; locators: Locator[] },
): Promise<PageElement> {
  const values = { locators: JSON.stringify(body.locators), updated_by: caller.userId, updated_at: new Date() };
  const row = await trx
    .insertInto('studio.page_element')
    .values({ org_id: caller.orgId, project_id: projectId, page: body.page, name: body.name, ...values })
    .onConflict((oc) => oc.columns(['project_id', 'page', 'name']).doUpdateSet(values))
    .returningAll()
    .executeTakeFirstOrThrow();
  return elementView(row);
}

// ---------- components ----------

export async function listComponents(trx: Tx, projectId: string): Promise<StudioComponent[]> {
  const rows = await trx
    .selectFrom('studio.component as c')
    .innerJoin('studio.component_version as v', (j) =>
      j.onRef('v.component_id', '=', 'c.id').onRef('v.version', '=', 'c.current_version'),
    )
    .select(['c.id', 'c.name', 'c.description', 'c.inputs', 'c.current_version', 'c.updated_at', 'c.meta', 'v.steps'])
    .where('c.project_id', '=', projectId)
    .orderBy('c.name')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    inputs: r.inputs,
    version: r.current_version,
    steps: r.steps as AutoStep[],
    // Rows from before the meta layer hold {}; parsing fills in the defaults.
    meta: ComponentMeta.parse(r.meta),
    updatedAt: r.updated_at.toISOString(),
  }));
}

/**
 * Publishes a component version. Tests keep the version they pinned; moving them to the new one is
 * a separate, explicit step after its impact run (technical-design §5.5).
 */
export async function saveComponent(
  trx: Tx,
  caller: Caller,
  projectId: string,
  body: z.infer<typeof SaveComponentBody>,
  componentId?: string,
): Promise<StudioComponent> {
  const elements = await elementMap(trx, projectId);
  assertValid(
    validateSteps(body.steps, {
      dataColumns: body.inputs,
      secrets: [],
      elementIds: new Set(elements.keys()),
      components: new Map(),
      insideComponent: true,
    }),
  );
  let id = componentId;
  let version = 1;
  if (!id) {
    const row = await trx
      .insertInto('studio.component')
      .values({
        org_id: caller.orgId,
        project_id: projectId,
        name: body.name,
        description: body.description,
        inputs: body.inputs,
        meta: JSON.stringify(body.meta),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = row.id;
  } else {
    const row = await trx
      .updateTable('studio.component')
      .set((eb) => ({
        name: body.name,
        description: body.description,
        inputs: body.inputs,
        meta: JSON.stringify(body.meta),
        current_version: eb('current_version', '+', 1),
        updated_at: new Date(),
      }))
      .where('id', '=', id)
      .where('project_id', '=', projectId)
      .returning('current_version')
      .executeTakeFirst();
    if (!row) throw notFound('Component');
    version = row.current_version;
  }
  await trx
    .insertInto('studio.component_version')
    .values({
      component_id: id,
      version,
      org_id: caller.orgId,
      steps: JSON.stringify(body.steps),
      inputs: body.inputs,
      changelog: body.changelog,
      created_by: caller.userId,
    })
    .execute();
  await recordEvent(trx, {
    type: 'studio.component.versioned',
    orgId: caller.orgId,
    projectId,
    actor: caller.userId,
    data: { component_id: id, version },
  });
  return (await listComponents(trx, projectId)).find((c) => c.id === id)!;
}

/**
 * Deletes a test from the list by archiving it: its versions stay, so past runs still show what ran.
 */
export async function archiveTest(trx: Tx, caller: Caller, projectId: string, testId: string): Promise<void> {
  const done = await trx
    .updateTable('studio.test')
    .set({ status: 'archived', updated_at: new Date() })
    .where('id', '=', testId)
    .where('project_id', '=', projectId)
    .where('status', '!=', 'archived')
    .returning('id')
    .executeTakeFirst();
  if (!done) throw notFound('Test');
  await recordEvent(trx, { type: 'studio.test.archived', orgId: caller.orgId, projectId, actor: caller.userId, data: { test_id: testId } });
}

/**
 * Turns a step-built test into a spec file in the code workspace (testing-studio-plan §3.7). One way:
 * the step version is archived, because arbitrary code can't be turned back into steps.
 */
export async function ejectTest(trx: Tx, caller: Caller, projectId: string, testId: string): Promise<{ path: string }> {
  const t = await testView(trx, projectId, testId);
  if (t.status === 'archived') throw badRequest('This test is archived.');
  const { code, runnable } = await testCode(trx, projectId, testId);
  if (!runnable) throw badRequest('A test with a manual step cannot become code; remove the manual step first.');
  const path = `tests/${t.key.toLowerCase()}.spec.ts`;
  const exists = await trx
    .selectFrom('studio.code_file')
    .select('id')
    .where('project_id', '=', projectId)
    .where('path', '=', path)
    .executeTakeFirst();
  if (exists) throw conflict(`${path} already exists in the workspace.`);
  await saveFile(trx, caller, projectId, { path, content: code });
  await trx.updateTable('studio.test').set({ status: 'archived', updated_at: new Date() }).where('id', '=', testId).execute();
  return { path };
}

import type { IntentBuildBody, IntentCommitBody, IntentCommitResult, StudioComponent } from '@tb/contracts';
import { DataSetBody, SaveComponentBody, SaveTestBody } from '@tb/contracts';
import type { z } from 'zod';
import { badRequest, notFound, type Tx } from '@tb/platform';
import { saveDataSet } from '@tb/repository';
import { randomUUID } from 'node:crypto';
import { listComponents, saveComponent, saveTest } from '../tests';
import { assemble, linkComponents } from './assemble';
import { buildDraft } from './build';

type Caller = { orgId: string; userId: string };

/** The rules draft, and what the model needs to refine it. Short: the model call happens after it, outside the transaction. */
export async function draftFromRecording(trx: Tx, projectId: string, body: IntentBuildBody) {
  const existing = await listComponents(trx, projectId);
  const prerequisiteComponent = body.prerequisiteComponentId ? existing.find((c) => c.id === body.prerequisiteComponentId) ?? null : null;
  if (body.prerequisiteComponentId && !prerequisiteComponent) throw notFound('Component');
  return buildDraft({
    title: body.title,
    intent: body.intent,
    prerequisite: body.prerequisiteComponentId ? [] : body.prerequisite,
    prerequisiteComponent,
    recording: body.recording,
    existing,
    newId: randomUUID,
    answers: body.answers,
  });
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/**
 * Saved components that may already set up these prerequisites, best first: the ones that say they
 * leave the app in that state, then by how much of the text their name and purpose share.
 */
export async function prerequisiteSuggestions(trx: Tx, projectId: string, text: string): Promise<Array<StudioComponent & { score: number }>> {
  const want = words(text);
  if (!want.size) return [];
  const score = (c: StudioComponent) => {
    const have = words(`${c.name} ${c.meta.purpose} ${c.meta.leaves} ${c.meta.tags.join(' ')}`);
    let hit = 0;
    for (const w of want) if (have.has(w)) hit++;
    return hit / want.size + (c.meta.origin === 'prerequisite' ? 0.1 : 0);
  };
  return (await listComponents(trx, projectId))
    .map((c) => ({ ...c, score: score(c) }))
    .filter((c) => c.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * The draft comes back from the browser after review, so each piece is parsed with its real schema
 * here: the review cannot smuggle in a step that a hand-made test could not have.
 */
function parsed<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(`The ${what} in this draft is not valid: ${r.error.issues[0]?.message ?? 'unknown problem'}`);
  return r.data;
}

/** A data set name not yet taken in the project. */
async function freeName(trx: Tx, projectId: string, wanted: string): Promise<string> {
  const taken = new Set(
    (await trx.selectFrom('repo.data_set').select('name').where('project_id', '=', projectId).execute()).map((r) => r.name.toLowerCase()),
  );
  let name = wanted.slice(0, 110);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted.slice(0, 105)} (${n})`;
  return name;
}

/**
 * Saves a reviewed draft in one transaction: new components first (so tests can pin them), then the
 * data sets, then the tests. Anything that fails the save rules rolls the whole commit back, so a
 * half-built test never appears.
 */
export async function commitDraft(trx: Tx, caller: Caller, projectId: string, body: IntentCommitBody): Promise<IntentCommitResult> {
  const draft = body.draft;
  if (!draft?.test?.steps?.length) throw badRequest('That draft has no test to save.');
  const out = assemble(draft, body);

  const saved = new Map<string, string>();
  for (const c of out.components)
    saved.set(c.placeholderId, (await saveComponent(trx, caller, projectId, parsed(SaveComponentBody, c.body, `segment "${c.body.name}"`))).id);

  const dataSet = async (suffix: string, rows: Record<string, string>[]) =>
    out.columns.length > 1 && rows.length
      ? (
          await saveDataSet(
            trx,
            caller,
            projectId,
            null,
            parsed(
              DataSetBody,
              {
                name: await freeName(trx, projectId, `${draft.title} · ${suffix}`),
                description: `Built from the intent "${draft.intent.intent.slice(0, 200)}". The case column says what each row tests.`,
                columns: out.columns,
                rows,
              },
              `${suffix} set`,
            ),
          )
        ).id
      : null;
  const validSet = await dataSet('valid data', out.valid);
  const invalidSet = out.negative ? await dataSet('invalid data', out.invalid) : null;

  const test = await saveTest(trx, caller, projectId, parsed(SaveTestBody, {
    title: out.test.title,
    kind: 'ui',
    caseId: null,
    dataSetId: validSet,
    secrets: out.test.secrets,
    steps: linkComponents(out.test.steps, saved),
    intent: draft.intent,
  }, 'test'));
  const negative =
    out.negative && invalidSet
      ? await saveTest(trx, caller, projectId, parsed(SaveTestBody, {
          title: out.negative.title.slice(0, 200),
          kind: 'ui',
          caseId: null,
          dataSetId: invalidSet,
          secrets: out.negative.secrets,
          steps: linkComponents(out.negative.steps, saved),
          intent: { ...draft.intent, goal: `Invalid input is refused: ${draft.intent.goal}`.slice(0, 2000) },
        }, 'negative test'))
      : null;

  return {
    testId: test.id,
    negativeTestId: negative?.id ?? null,
    componentIds: [...saved.values()],
    dataSetIds: [validSet, invalidSet].filter((x): x is string => !!x),
  };
}

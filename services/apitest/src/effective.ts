import type { OverlayPatch } from '@tb/contracts';
import { notFound, type ObjectStorage, type Tx } from '@tb/platform';
import { applyPatches } from './enrich';

// The effective spec (plan §9): a stored version's document with the answered enrichment patches on
// top. Everything that tests from a spec (generation, drift, mocks) reads it through here.

export interface LoadedSpec {
  specId: string;
  name: string;
  version: number;
  current: number;
  /** The document as uploaded. */
  raw: Record<string, unknown>;
  /** With the overlay applied. */
  doc: Record<string, unknown>;
  /** Answers whose target is gone in this version (they came from an older one). */
  stale: Set<string>;
}

export async function loadSpecDoc(trx: Tx, storage: ObjectStorage, projectId: string, specId: string, version?: number): Promise<LoadedSpec> {
  const spec = await trx.selectFrom('apitest.spec').select(['id', 'name', 'current_version']).where('id', '=', specId).where('project_id', '=', projectId).executeTakeFirst();
  if (!spec) throw notFound('Spec');
  const v = await trx.selectFrom('apitest.spec_version').select(['version', 'storage_key']).where('spec_id', '=', spec.id).where('version', '=', version ?? spec.current_version).executeTakeFirst();
  if (!v) throw notFound('Spec version');
  const raw = JSON.parse(Buffer.from(await storage.read(v.storage_key)).toString('utf8')) as Record<string, unknown>;
  const answers = await trx.selectFrom('apitest.enrichment_answer').select(['question_id', 'patches']).where('spec_id', '=', spec.id).where('status', '=', 'answered').execute();
  const patches = answers.flatMap((a) => a.patches as OverlayPatch[]);
  const { doc, skipped } = applyPatches(raw, patches);
  return { specId: spec.id, name: spec.name, version: v.version, current: spec.current_version, raw, doc: doc as Record<string, unknown>, stale: new Set(skipped.map((p) => p.question)) };
}

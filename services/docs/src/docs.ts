import {
  caseKey,
  parseCaseKey,
  type CaseFlag,
  type CaseStatus,
  type Coverage,
  type DocumentDetail,
  type DocumentSummary,
  type ExtractedRequirement,
  type LinkedCase,
  type RequirementChange,
  type RequirementRow,
  type Result,
  type Traceability,
  type VersionCompare,
  type VersionResult,
} from '@tb/contracts';
import { badRequest, notFound, recordEvent, type RequirementJson, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { alignRefs, diffRequirements } from './requirements';

export interface Actor {
  orgId: string;
  userId: string;
}

export interface Extraction {
  requirements: ExtractedRequirement[];
  /** "tags", or "provider:model" when an AI extracted them. */
  extractedBy: string;
}

function coverageOf(linked: number, ready: number): Coverage {
  if (linked === 0) return 'none';
  return ready === linked ? 'full' : 'partial';
}

export async function listDocuments(trx: Tx, projectId: string): Promise<DocumentSummary[]> {
  const rows = await trx
    .selectFrom('docs.document as d')
    .innerJoin('docs.document_version as v', (j) =>
      j.onRef('v.document_id', '=', 'd.id').onRef('v.version', '=', 'd.current_version'),
    )
    .innerJoin('iam.app_user as u', 'u.id', 'v.created_by')
    .select((eb) => [
      'd.id',
      'd.title',
      'd.current_version',
      'd.updated_at',
      'u.name as updated_by',
      eb
        .selectFrom('docs.requirement as r')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('r.document_id', '=', 'd.id')
        .where('r.change', '<>', 'removed')
        .as('requirements'),
      eb
        .selectFrom('docs.requirement as r')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('r.document_id', '=', 'd.id')
        .where('r.change', '<>', 'removed')
        .where((w) =>
          w.exists(
            w
              .selectFrom('docs.requirement_case as rc')
              .select('rc.case_id')
              .whereRef('rc.requirement_id', '=', 'r.id'),
          ),
        )
        .as('covered'),
      eb
        .selectFrom('docs.case_flag as f')
        .innerJoin('docs.requirement as r', 'r.id', 'f.requirement_id')
        .innerJoin('repo.test_case as c', (j) =>
          j.onRef('c.id', '=', 'f.case_id').onRef('c.project_id', '=', 'f.project_id'),
        )
        .select(sql<number>`count(DISTINCT f.case_id)`.as('n'))
        .whereRef('r.document_id', '=', 'd.id')
        .where('c.status', '=', 'needs_review')
        .as('needs_review'),
    ])
    .where('d.project_id', '=', projectId)
    .orderBy('d.updated_at', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.current_version,
    updatedAt: r.updated_at.toISOString(),
    updatedBy: r.updated_by,
    requirements: Number(r.requirements ?? 0),
    covered: Number(r.covered ?? 0),
    needsReview: Number(r.needs_review ?? 0),
  }));
}

async function findDocument(trx: Tx, projectId: string, documentId: string) {
  const doc = await trx
    .selectFrom('docs.document')
    .selectAll()
    .where('id', '=', documentId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!doc) throw notFound('Document');
  return doc;
}

async function readVersion(trx: Tx, documentId: string, version: number) {
  const v = await trx
    .selectFrom('docs.document_version')
    .selectAll()
    .where('document_id', '=', documentId)
    .where('version', '=', version)
    .executeTakeFirst();
  if (!v) throw notFound(`Version ${version}`);
  return v;
}

/** Requirement rows with how many cases cover each and whether those cases are Ready. */
async function requirementRows(trx: Tx, documentId: string): Promise<RequirementRow[]> {
  const rows = await trx
    .selectFrom('docs.requirement as r')
    .leftJoin('docs.requirement_case as rc', 'rc.requirement_id', 'r.id')
    .leftJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'rc.case_id').onRef('c.project_id', '=', 'rc.project_id'),
    )
    .select((eb) => [
      'r.id',
      'r.ref',
      'r.title',
      'r.text',
      'r.change',
      'r.changed_in',
      eb.fn.count<number>('c.id').as('linked'),
      sql<number>`count(c.id) FILTER (WHERE c.status = 'ready')`.as('ready'),
    ])
    .where('r.document_id', '=', documentId)
    .groupBy('r.id')
    .orderBy('r.position')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    ref: r.ref,
    title: r.title,
    text: r.text,
    change: r.change as RequirementChange,
    changedIn: r.changed_in,
    caseCount: r.linked,
    coverage: coverageOf(r.linked, r.ready),
  }));
}

export async function getDocument(
  trx: Tx,
  projectId: string,
  documentId: string,
  version?: number,
): Promise<DocumentDetail> {
  const doc = await findDocument(trx, projectId, documentId);
  const v = await readVersion(trx, documentId, version ?? doc.current_version);
  const versions = await trx
    .selectFrom('docs.document_version as v')
    .innerJoin('iam.app_user as u', 'u.id', 'v.created_by')
    .select(['v.version', 'v.created_at', 'v.extracted_by', 'u.name'])
    .where('v.document_id', '=', documentId)
    .orderBy('v.version', 'desc')
    .execute();
  const requirements = await requirementRows(trx, documentId);
  const latest = requirements.filter((r) => r.changedIn === doc.current_version && doc.current_version > 1);
  const flagged = await trx
    .selectFrom('docs.case_flag as f')
    .innerJoin('docs.requirement as r', 'r.id', 'f.requirement_id')
    .innerJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'f.case_id').onRef('c.project_id', '=', 'f.project_id'),
    )
    .select(sql<number>`count(DISTINCT f.case_id)`.as('n'))
    .where('r.document_id', '=', documentId)
    .where('c.status', '=', 'needs_review')
    .executeTakeFirstOrThrow();
  return {
    id: doc.id,
    title: doc.title,
    currentVersion: doc.current_version,
    version: v.version,
    body: v.body,
    versions: versions.map((x) => ({
      version: x.version,
      createdAt: x.created_at.toISOString(),
      author: x.name,
      extractedBy: x.extracted_by,
    })),
    requirements,
    impact: {
      changed: latest.filter((r) => r.change === 'changed').length,
      added: latest.filter((r) => r.change === 'added').length,
      removed: latest.filter((r) => r.change === 'removed').length,
      needsReview: Number(flagged.n),
      uncoveredAdded: latest.filter((r) => r.change === 'added' && r.caseCount === 0).length,
    },
  };
}

export async function createDocument(
  trx: Tx,
  actor: Actor,
  projectId: string,
  title: string,
  body: string,
  extraction: Extraction,
): Promise<{ id: string }> {
  const doc = await trx
    .insertInto('docs.document')
    .values({ org_id: actor.orgId, project_id: projectId, title, created_by: actor.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('docs.document_version')
    .values({
      document_id: doc.id,
      version: 1,
      org_id: actor.orgId,
      body,
      requirements: JSON.stringify(extraction.requirements),
      extracted_by: extraction.extractedBy,
      created_by: actor.userId,
    })
    .execute();
  if (extraction.requirements.length)
    await trx
      .insertInto('docs.requirement')
      .values(
        extraction.requirements.map((r, position) => ({
          org_id: actor.orgId,
          project_id: projectId,
          document_id: doc.id,
          ref: r.ref,
          title: r.title,
          text: r.text,
          position,
          change: 'added',
          changed_in: 1,
        })),
      )
      .execute();
  await recordEvent(trx, {
    type: 'document.created',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { document_id: doc.id, title, requirements: extraction.requirements.length },
  });
  return doc;
}

/** The previous version's requirements, used to align a new extraction before it is stored. */
export async function currentRequirements(
  trx: Tx,
  projectId: string,
  documentId: string,
): Promise<RequirementJson[]> {
  const doc = await findDocument(trx, projectId, documentId);
  return (await readVersion(trx, documentId, doc.current_version)).requirements;
}

/**
 * Stores a new version and applies its impact (HLD §5.13): changed requirements flag their linked
 * cases "Needs review", removed ones flag theirs "Possibly obsolete", added ones show up as coverage
 * gaps. Flagged cases keep running; the execute view warns until the owner confirms or edits them.
 */
export async function addVersion(
  trx: Tx,
  actor: Actor,
  projectId: string,
  documentId: string,
  body: string,
  extraction: Extraction,
): Promise<VersionResult> {
  const doc = await findDocument(trx, projectId, documentId);
  const prev = await readVersion(trx, documentId, doc.current_version);
  if (prev.body === body) throw badRequest('This is the same text as the current version.');
  // Tagged documents carry their own ids; AI-extracted lists are renumbered each time, so align them.
  const next =
    extraction.extractedBy === 'tags'
      ? extraction.requirements
      : alignRefs(prev.requirements, extraction.requirements);
  const version = doc.current_version + 1;
  const diff = diffRequirements(prev.requirements, next);

  await trx
    .insertInto('docs.document_version')
    .values({
      document_id: documentId,
      version,
      org_id: actor.orgId,
      body,
      requirements: JSON.stringify(next),
      extracted_by: extraction.extractedBy,
      created_by: actor.userId,
    })
    .execute();
  await trx
    .updateTable('docs.document')
    .set({ current_version: version, updated_at: new Date() })
    .where('id', '=', documentId)
    .execute();

  const changeOf = new Map(diff.map((d) => [d.ref, d.change]));
  for (const [position, r] of next.entries()) {
    const change = changeOf.get(r.ref)!;
    await trx
      .insertInto('docs.requirement')
      .values({
        org_id: actor.orgId,
        project_id: projectId,
        document_id: documentId,
        ref: r.ref,
        title: r.title,
        text: r.text,
        position,
        change,
        changed_in: version,
      })
      .onConflict((oc) =>
        oc.columns(['document_id', 'ref']).doUpdateSet({
          title: r.title,
          text: r.text,
          position,
          change,
          // An unchanged requirement keeps the version it last changed in.
          changed_in: change === 'unchanged' ? sql`docs.requirement.changed_in` : version,
        }),
      )
      .execute();
  }
  const removed = diff.filter((d) => d.change === 'removed').map((d) => d.ref);
  if (removed.length)
    await trx
      .updateTable('docs.requirement')
      .set({ change: 'removed', changed_in: version })
      .where('document_id', '=', documentId)
      .where('ref', 'in', removed)
      .where('change', '<>', 'removed')
      .execute();

  const flagged = await flagImpact(trx, actor, projectId, documentId, doc.title, version, diff);
  const count = (c: RequirementChange) => diff.filter((d) => d.change === c).length;
  const result = {
    version,
    changed: count('changed'),
    added: count('added'),
    removed: count('removed'),
    flagged,
  };
  await recordEvent(trx, {
    type: 'document.versioned',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { document_id: documentId, ...result },
  });
  return result;
}

async function flagImpact(
  trx: Tx,
  actor: Actor,
  projectId: string,
  documentId: string,
  title: string,
  version: number,
  diff: ReturnType<typeof diffRequirements>,
): Promise<number> {
  const affected = diff.filter((d) => d.change === 'changed' || d.change === 'removed');
  if (!affected.length) return 0;
  const links = await trx
    .selectFrom('docs.requirement_case as rc')
    .innerJoin('docs.requirement as r', 'r.id', 'rc.requirement_id')
    .select(['rc.case_id', 'r.id as requirement_id', 'r.ref'])
    .where('r.document_id', '=', documentId)
    .where(
      'r.ref',
      'in',
      affected.map((d) => d.ref),
    )
    .execute();
  if (!links.length) return 0;
  const kindOf = new Map(
    affected.map((d) => [d.ref, d.change === 'removed' ? 'possibly_obsolete' : 'needs_review']),
  );
  await trx
    .insertInto('docs.case_flag')
    .values(
      links.map((l) => ({
        case_id: l.case_id,
        requirement_id: l.requirement_id,
        org_id: actor.orgId,
        project_id: projectId,
        kind: kindOf.get(l.ref)!,
        reason: `${l.ref} ${kindOf.get(l.ref) === 'needs_review' ? 'changed' : 'was removed'} in ${title} v${version}`,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['case_id', 'requirement_id']).doUpdateSet((eb) => ({
        kind: eb.ref('excluded.kind'),
        reason: eb.ref('excluded.reason'),
        flagged_at: new Date(),
      })),
    )
    .execute();

  const caseIds = [...new Set(links.map((l) => l.case_id))];
  const updated = await trx
    .updateTable('repo.test_case')
    .set({ status: 'needs_review', updated_at: new Date() })
    .where('project_id', '=', projectId)
    .where('id', 'in', caseIds)
    .where('status', '<>', 'obsolete')
    .returning(['id', 'key_no'])
    .execute();
  // One event per case keeps search and the case's history exact; PRD links are tens of cases, not millions.
  for (const c of updated)
    await recordEvent(trx, {
      type: 'testcase.updated',
      orgId: actor.orgId,
      projectId,
      actor: actor.userId,
      data: { case_id: c.id, key: caseKey(c.key_no), fields: ['status'], reason: 'requirement_changed' },
    });
  return updated.length;
}

export async function compareVersions(
  trx: Tx,
  projectId: string,
  documentId: string,
  base: number,
  head: number,
): Promise<VersionCompare> {
  await findDocument(trx, projectId, documentId);
  const [a, b] = await Promise.all([readVersion(trx, documentId, base), readVersion(trx, documentId, head)]);
  return {
    base: { version: a.version, body: a.body },
    head: { version: b.version, body: b.body },
    changes: diffRequirements(a.requirements, b.requirements),
  };
}

export async function findRequirement(trx: Tx, projectId: string, requirementId: string) {
  const r = await trx
    .selectFrom('docs.requirement as r')
    .innerJoin('docs.document as d', 'd.id', 'r.document_id')
    .select(['r.id', 'r.ref', 'r.title', 'r.text', 'r.change', 'd.title as document'])
    .where('r.id', '=', requirementId)
    .where('r.project_id', '=', projectId)
    .executeTakeFirst();
  if (!r) throw notFound('Requirement');
  return r;
}

export async function linkedCases(trx: Tx, projectId: string, requirementId: string): Promise<LinkedCase[]> {
  await findRequirement(trx, projectId, requirementId);
  const rows = await trx
    .selectFrom('docs.requirement_case as rc')
    .innerJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'rc.case_id').onRef('c.project_id', '=', 'rc.project_id'),
    )
    .leftJoin('docs.case_flag as f', (j) =>
      j.onRef('f.case_id', '=', 'rc.case_id').onRef('f.requirement_id', '=', 'rc.requirement_id'),
    )
    .select(['c.key_no', 'c.title', 'c.status', 'c.last_result', 'f.kind'])
    .where('rc.requirement_id', '=', requirementId)
    .orderBy('c.key_no')
    .execute();
  return rows.map((r) => ({
    key: caseKey(r.key_no),
    title: r.title,
    status: r.status as CaseStatus,
    lastResult: r.last_result as Result,
    flagged: r.kind !== null && r.status === 'needs_review',
  }));
}

export async function linkCases(
  trx: Tx,
  actor: Actor,
  projectId: string,
  requirementId: string,
  keys: string[],
): Promise<{ linked: number; unknown: string[] }> {
  await findRequirement(trx, projectId, requirementId);
  const nums = keys.map((k) => parseCaseKey(k)!);
  const cases = await trx
    .selectFrom('repo.test_case')
    .select(['id', 'key_no'])
    .where('project_id', '=', projectId)
    .where('key_no', 'in', nums)
    .execute();
  const found = new Set(cases.map((c) => c.key_no));
  if (cases.length)
    await trx
      .insertInto('docs.requirement_case')
      .values(
        cases.map((c) => ({
          requirement_id: requirementId,
          case_id: c.id,
          org_id: actor.orgId,
          project_id: projectId,
          linked_by: actor.userId,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  return { linked: cases.length, unknown: nums.filter((n) => !found.has(n)).map(caseKey) };
}

export async function unlinkCase(
  trx: Tx,
  projectId: string,
  requirementId: string,
  key: string,
): Promise<void> {
  await findRequirement(trx, projectId, requirementId);
  await trx
    .deleteFrom('docs.requirement_case')
    .where('requirement_id', '=', requirementId)
    .where('case_id', '=', (eb) =>
      eb
        .selectFrom('repo.test_case')
        .select('id')
        .where('project_id', '=', projectId)
        .where('key_no', '=', parseCaseKey(key)!),
    )
    .execute();
}

/**
 * Requirement × environment matrix: coverage, and the pass rate of each linked case's latest result
 * per environment, with open bugs on those cases.
 */
export async function traceability(trx: Tx, projectId: string, documentId: string): Promise<Traceability> {
  await findDocument(trx, projectId, documentId);
  const reqs = (await requirementRows(trx, documentId)).filter((r) => r.change !== 'removed');
  const results = await sql<{ requirement_id: string; environment: string; passed: number; total: number }>`
    WITH links AS (
      SELECT rc.requirement_id, rc.case_id FROM docs.requirement_case rc
        JOIN docs.requirement r ON r.id = rc.requirement_id
       WHERE r.document_id = ${documentId}
    ), latest AS (
      SELECT DISTINCT ON (i.case_id, run.environment) i.case_id, run.environment, i.status
        FROM exec.run_item i JOIN exec.run run ON run.id = i.run_id
       WHERE i.project_id = ${projectId} AND i.status <> 'untested'
         AND i.case_id IN (SELECT case_id FROM links)
       ORDER BY i.case_id, run.environment, i.updated_at DESC
    )
    SELECT l.requirement_id, t.environment,
           count(*) FILTER (WHERE t.status = 'passed')::int AS passed, count(*)::int AS total
      FROM links l JOIN latest t ON t.case_id = l.case_id
     GROUP BY 1, 2`.execute(trx);
  const bugs = await trx
    .selectFrom('docs.requirement_case as rc')
    .innerJoin('docs.requirement as r', 'r.id', 'rc.requirement_id')
    .innerJoin('defect.item_link as l', 'l.case_id', 'rc.case_id')
    .innerJoin('defect.defect as d', 'd.id', 'l.defect_id')
    .select(['rc.requirement_id', 'd.jira_key'])
    .distinct()
    .where('r.document_id', '=', documentId)
    .where('d.status_category', '<>', 'done')
    .execute();

  const environments = [...new Set(results.rows.map((r) => r.environment))].sort();
  return {
    environments,
    rows: reqs.map((r) => ({
      requirementId: r.id,
      ref: r.ref,
      title: r.title,
      coverage: r.coverage,
      caseCount: r.caseCount,
      passRate: Object.fromEntries(
        environments.map((env) => {
          const hit = results.rows.find((x) => x.requirement_id === r.id && x.environment === env);
          return [env, hit ? Math.round((hit.passed / hit.total) * 1000) / 10 : null];
        }),
      ),
      openBugs: bugs.filter((b) => b.requirement_id === r.id).map((b) => b.jira_key),
    })),
  };
}

/** Why a case is flagged, for the banner on the case and in the execute view. */
export async function caseFlags(trx: Tx, projectId: string, key: string): Promise<CaseFlag[]> {
  const rows = await trx
    .selectFrom('docs.case_flag as f')
    .innerJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'f.case_id').onRef('c.project_id', '=', 'f.project_id'),
    )
    .innerJoin('docs.requirement as r', 'r.id', 'f.requirement_id')
    .innerJoin('docs.document as d', 'd.id', 'r.document_id')
    .select(['f.kind', 'f.reason', 'f.flagged_at', 'd.title', 'r.ref'])
    .where('f.project_id', '=', projectId)
    .where('c.key_no', '=', parseCaseKey(key)!)
    .where('c.status', '=', 'needs_review')
    .orderBy('f.flagged_at', 'desc')
    .execute();
  return rows.map((r) => ({
    kind: r.kind as CaseFlag['kind'],
    reason: r.reason,
    documentTitle: r.title,
    requirementRef: r.ref,
    flaggedAt: r.flagged_at.toISOString(),
  }));
}

/** The owner confirms the case still matches its requirements: flags go, the case is Ready again. */
export async function confirmReview(trx: Tx, actor: Actor, projectId: string, key: string): Promise<void> {
  const c = await trx
    .selectFrom('repo.test_case')
    .select(['id', 'key_no', 'status'])
    .where('project_id', '=', projectId)
    .where('key_no', '=', parseCaseKey(key)!)
    .executeTakeFirst();
  if (!c) throw notFound('Case');
  await trx.deleteFrom('docs.case_flag').where('case_id', '=', c.id).execute();
  if (c.status !== 'needs_review') return;
  await trx
    .updateTable('repo.test_case')
    .set({ status: 'ready', updated_at: new Date() })
    .where('project_id', '=', projectId)
    .where('id', '=', c.id)
    .execute();
  await recordEvent(trx, {
    type: 'testcase.updated',
    orgId: actor.orgId,
    projectId,
    actor: actor.userId,
    data: { case_id: c.id, key: caseKey(c.key_no), fields: ['status'], reason: 'review_confirmed' },
  });
}

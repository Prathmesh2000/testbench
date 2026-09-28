import {
  caseKey,
  runKey,
  type CaseJiraLink,
  type DefectDetail,
  type DefectRow,
  type JiraStatus,
  type Result,
  type Severity,
  type SimilarDefect,
  type SyncStatus,
} from '@tb/contracts';
import { AppError, badRequest, notFound, recordEvent, withTenant, type Db, type Tx } from '@tb/platform';
import { sql } from 'kysely';
import { bugDescription, commentDoc, JIRA_PRIORITY, type BugContext } from './bug-report';
import { JiraError, jqlString, type JiraClient, type JiraIssue } from './jira';
import { searchTerms, similarity } from './similarity';

interface Caller {
  orgId: string;
  userId: string;
  name: string;
}

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/** Jira errors become API errors the tester can act on; anything else propagates as a 500. */
async function jiraCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof JiraError)
      throw new AppError(err.status === 503 ? 503 : 502, 'jira_error', err.message);
    throw err;
  }
}

async function projectKey(trx: Tx, projectId: string): Promise<string> {
  // The Jira project is assumed to share the Testbench project key (PAY → PAY) until per-project
  // Jira mapping arrives with the admin console (M5).
  const p = await trx
    .selectFrom('repo.project')
    .select('key')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  return p.key;
}

// ---------- reads ----------

function defectRows(trx: Tx, projectId: string) {
  return trx
    .selectFrom('defect.defect as d')
    .innerJoin('iam.app_user as u', 'u.id', 'd.created_by')
    .select([
      'd.id',
      'd.jira_key',
      'd.issue_type',
      'd.summary',
      'd.status',
      'd.status_category',
      'd.severity',
      'd.assignee_name',
      'd.fix_version',
      'd.created_at',
      'd.synced_at',
      'u.id as reporter_id',
      'u.name as reporter_name',
      'u.email as reporter_email',
    ])
    .select((eb) => [
      // Newest retest state wins; any pending retest makes the whole defect "pending".
      eb
        .selectFrom('defect.retest as r')
        .select(
          sql<string>`CASE WHEN bool_or(r.status = 'pending') THEN 'pending' ELSE (array_agg(r.status ORDER BY r.done_at DESC NULLS LAST))[1] END`.as(
            's',
          ),
        )
        .whereRef('r.defect_id', '=', 'd.id')
        .as('retest'),
    ])
    .where('d.project_id', '=', projectId);
}
type DefectRecord = Awaited<ReturnType<ReturnType<typeof defectRows>['executeTakeFirstOrThrow']>>;

async function withCases(trx: Tx, jira: JiraClient, rows: DefectRecord[]): Promise<DefectRow[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  // Cases a defect touches: through failed run items, and linked to the case directly.
  const links = await trx
    .selectFrom('defect.item_link as l')
    .innerJoin('repo.test_case as c', 'c.id', 'l.case_id')
    .select(['l.defect_id', 'c.key_no', 'c.title'])
    .where('l.defect_id', '=', (eb) => eb.fn.any(eb.val(ids)))
    .union((eb) =>
      eb
        .selectFrom('defect.case_link as k')
        .innerJoin('repo.test_case as c', (j) =>
          j.onRef('c.id', '=', 'k.case_id').onRef('c.project_id', '=', 'k.project_id'),
        )
        .select(['k.defect_id', 'c.key_no', 'c.title'])
        .where('k.defect_id', '=', (w) => w.fn.any(w.val(ids))),
    )
    .execute();
  return rows.map((r) => ({
    id: r.id,
    jiraKey: r.jira_key,
    jiraUrl: jira.browseUrl(r.jira_key),
    issueType: r.issue_type,
    summary: r.summary,
    status: r.status,
    statusCategory: r.status_category as DefectRow['statusCategory'],
    severity: r.severity as Severity,
    assignee: r.assignee_name,
    fixVersion: r.fix_version,
    createdAt: r.created_at.toISOString(),
    syncedAt: r.synced_at.toISOString(),
    reporter: { id: r.reporter_id, name: r.reporter_name, email: r.reporter_email },
    linkedCases: links
      .filter((l) => l.defect_id === r.id)
      .map((l) => ({ key: caseKey(l.key_no), title: l.title })),
    retest: (r.retest as DefectRow['retest']) ?? null,
  }));
}

export async function listDefects(
  trx: Tx,
  jira: JiraClient,
  caller: Caller,
  projectId: string,
  q: {
    view: 'all' | 'retest' | 'mine';
    status: 'open' | 'done' | 'any';
    caseId?: string;
    jiraStatus?: string;
    type?: 'bugs' | 'all';
  },
): Promise<DefectRow[]> {
  let query = defectRows(trx, projectId).orderBy('d.created_at', 'desc').limit(500);
  if (q.view === 'mine') query = query.where('d.created_by', '=', caller.userId);
  if (q.view === 'retest') {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('defect.retest as r')
          .select('r.id')
          .whereRef('r.defect_id', '=', 'd.id')
          .where('r.status', '=', 'pending'),
      ),
    );
  }
  if (q.status === 'open') query = query.where('d.status_category', '!=', 'done');
  if (q.status === 'done') query = query.where('d.status_category', '=', 'done');
  if (q.jiraStatus) query = query.where('d.status', '=', q.jiraStatus);
  if (q.type !== 'all') query = query.where('d.issue_type', '=', 'Bug');
  if (q.caseId)
    query = query.where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('defect.item_link as l')
            .select('l.defect_id')
            .whereRef('l.defect_id', '=', 'd.id')
            .where('l.case_id', '=', q.caseId!),
        ),
        eb.exists(
          eb
            .selectFrom('defect.case_link as k')
            .select('k.defect_id')
            .whereRef('k.defect_id', '=', 'd.id')
            .where('k.case_id', '=', q.caseId!),
        ),
      ]),
    );
  return withCases(trx, jira, await query.execute());
}

export async function getDefect(
  trx: Tx,
  jira: JiraClient,
  projectId: string,
  defectId: string,
): Promise<DefectDetail> {
  const row = await defectRows(trx, projectId).where('d.id', '=', defectId).executeTakeFirst();
  if (!row) throw notFound('Defect');
  const [base] = await withCases(trx, jira, [row]);
  const [events, retests, items] = await Promise.all([
    trx
      .selectFrom('defect.event as e')
      .leftJoin('iam.app_user as u', 'u.id', 'e.actor')
      .select([
        'e.kind',
        'e.detail',
        'e.created_at',
        'u.id as actor_id',
        'u.name as actor_name',
        'u.email as actor_email',
      ])
      .where('e.defect_id', '=', defectId)
      .orderBy('e.created_at')
      .execute(),
    trx
      .selectFrom('defect.retest as r')
      .innerJoin('repo.test_case as c', 'c.id', 'r.case_id')
      .leftJoin('iam.app_user as u', 'u.id', 'r.assignee_id')
      .select([
        'r.id',
        'r.status',
        'r.build',
        'r.note',
        'r.requested_at',
        'c.key_no',
        'c.title',
        'u.id as assignee_id',
        'u.name as assignee_name',
        'u.email as assignee_email',
      ])
      .where('r.defect_id', '=', defectId)
      .orderBy('r.requested_at', 'desc')
      .execute(),
    trx
      .selectFrom('defect.item_link as l')
      .innerJoin('exec.run_item as i', 'i.id', 'l.run_item_id')
      .innerJoin('exec.run as run', 'run.id', 'i.run_id')
      .innerJoin('repo.test_case as c', 'c.id', 'l.case_id')
      .select(['run.key_no as run_key', 'run.name as run_name', 'run.build', 'i.config', 'c.key_no'])
      .where('l.defect_id', '=', defectId)
      .orderBy('l.linked_at')
      .execute(),
  ]);
  return {
    ...base!,
    timeline: events.map((e) => ({
      kind: e.kind,
      detail: e.detail,
      at: e.created_at.toISOString(),
      actor: e.actor_id ? { id: e.actor_id, name: e.actor_name!, email: e.actor_email! } : null,
    })),
    retests: retests.map((r) => ({
      id: r.id,
      caseKey: caseKey(r.key_no),
      caseTitle: r.title,
      status: r.status as 'pending',
      build: r.build,
      note: r.note,
      requestedAt: r.requested_at.toISOString(),
      assignee: r.assignee_id
        ? { id: r.assignee_id, name: r.assignee_name!, email: r.assignee_email! }
        : null,
    })),
    items: items.map((i) => ({
      runKey: runKey(i.run_key),
      runName: i.run_name,
      build: i.build,
      config: i.config,
      caseKey: caseKey(i.key_no),
    })),
  };
}

/**
 * Up to five open bugs that look like the one about to be logged: candidates from Jira's text search
 * plus our own linked defects, ranked together by trigram similarity. If Jira is unreachable the check
 * still returns what we know locally rather than blocking the tester.
 */
export async function similarDefects(
  trx: Tx,
  jira: JiraClient,
  projectId: string,
  summary: string,
): Promise<SimilarDefect[]> {
  const key = await projectKey(trx, projectId);
  const terms = searchTerms(summary);
  const [remote, local] = await Promise.all([
    terms.length
      ? jira
          .search(
            `project = ${jqlString(key)} AND statusCategory != Done AND text ~ ${jqlString(terms.join(' '))}`,
            20,
          )
          .then(
            (r) => r.issues,
            () => [] as JiraIssue[],
          )
      : Promise.resolve([] as JiraIssue[]),
    trx
      .selectFrom('defect.defect')
      .select(['jira_key', 'summary', 'status', 'status_category'])
      .where('project_id', '=', projectId)
      .where('status_category', '!=', 'done')
      .orderBy(sql`similarity(summary, ${summary})`, 'desc')
      .limit(10)
      .execute(),
  ]);
  const known = new Set(local.map((l) => l.jira_key));
  const candidates = new Map<string, SimilarDefect>();
  for (const i of remote) {
    candidates.set(i.key, {
      jiraKey: i.key,
      summary: i.fields.summary,
      status: i.fields.status.name,
      statusCategory: i.fields.status.statusCategory.key,
      similarity: 0,
      known: known.has(i.key),
    });
  }
  for (const l of local) {
    if (!candidates.has(l.jira_key))
      candidates.set(l.jira_key, {
        jiraKey: l.jira_key,
        summary: l.summary,
        status: l.status,
        statusCategory: l.status_category as SimilarDefect['statusCategory'],
        similarity: 0,
        known: true,
      });
  }
  return (
    [...candidates.values()]
      .map((c) => ({ ...c, similarity: Math.round(similarity(summary, c.summary) * 100) }))
      // Below ~30% the overlap is mostly shared words like "payment"; showing those buries real duplicates.
      .filter((c) => c.similarity >= 30)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
  );
}

export async function syncStatus(trx: Tx, projectId: string): Promise<SyncStatus> {
  const s = await trx
    .selectFrom('defect.sync_state')
    .select(['last_run_at', 'last_error'])
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  return {
    connected: true,
    lastSyncAt: s?.last_run_at.toISOString() ?? null,
    lastError: s?.last_error ?? null,
  };
}

// ---------- writes ----------

/** What the bug is about: the run item, its steps and results, gathered for the report. */
async function itemContext(
  trx: Tx,
  projectId: string,
  runId: string,
  itemId: string,
  caller: Caller,
  webUrl: string,
): Promise<BugContext & { caseId: string }> {
  const item = await trx
    .selectFrom('exec.run_item as i')
    .innerJoin('exec.run as r', 'r.id', 'i.run_id')
    .innerJoin('repo.test_case as c', (j) =>
      j.onRef('c.id', '=', 'i.case_id').onRef('c.project_id', '=', 'i.project_id'),
    )
    .innerJoin('repo.case_version as v', (j) =>
      j
        .onRef('v.project_id', '=', 'i.project_id')
        .onRef('v.case_id', '=', 'i.case_id')
        .onRef('v.version', '=', 'i.case_version'),
    )
    .select([
      'i.id',
      'i.case_id',
      'i.config',
      'i.step_status',
      'r.key_no as run_key',
      'r.name as run_name',
      'r.environment',
      'r.build',
      'c.key_no',
      'v.title',
      'v.steps',
      'v.preconditions',
    ])
    .where('i.id', '=', itemId)
    .where('i.run_id', '=', runId)
    .where('i.project_id', '=', projectId)
    .executeTakeFirst();
  if (!item) throw notFound('Run item');
  const statuses = item.step_status as Result[];
  const failedAt = statuses.findIndex((s) => s === 'failed' || s === 'blocked');
  const [actual, evidence] = await Promise.all([
    failedAt === -1
      ? null
      : trx
          .selectFrom('exec.step_result')
          .select('actual')
          .where('run_item_id', '=', itemId)
          .where('step_index', '=', failedAt)
          .where('actual', 'is not', null)
          .orderBy('recorded_at', 'desc')
          .limit(1)
          .executeTakeFirst(),
    trx
      .selectFrom('exec.evidence')
      .select('file_name')
      .where('run_item_id', '=', itemId)
      .orderBy('created_at')
      .execute(),
  ]);
  return {
    caseId: item.case_id,
    caseKey: caseKey(item.key_no),
    caseTitle: item.title,
    runKey: runKey(item.run_key),
    runName: item.run_name,
    environment: item.environment,
    build: item.build,
    config: item.config,
    preconditions: item.preconditions,
    steps: item.steps,
    failedAt,
    actual: actual?.actual ?? null,
    evidence: evidence.map((e) => e.file_name),
    reporter: caller.name,
    link: `${webUrl}/runs/${runId}?item=${itemId}`,
  };
}

async function addEvent(
  trx: Tx,
  orgId: string,
  defectId: string,
  kind: string,
  detail: string,
  actor: string | null,
) {
  await trx
    .insertInto('defect.event')
    .values({ org_id: orgId, defect_id: defectId, kind, detail, actor })
    .execute();
}

/**
 * Creates a Jira bug from a failed run item and links it. The Jira call comes after every read that
 * could fail validation and before the few inserts, so a rejected request never leaves an orphan
 * issue in Jira; the remaining window (Jira succeeds, our insert fails) is small and visible there.
 */
export async function logBug(
  trx: Tx,
  jira: JiraClient,
  caller: Caller,
  projectId: string,
  webUrl: string,
  body: { runId: string; itemId: string; summary: string; severity: Severity; labels: string[] },
): Promise<DefectRow> {
  const ctx = await itemContext(trx, projectId, body.runId, body.itemId, caller, webUrl);
  const jiraProject = await projectKey(trx, projectId);
  const created = await jiraCall(() =>
    jira.createIssue({
      projectKey: jiraProject,
      summary: body.summary,
      description: bugDescription(ctx),
      priority: JIRA_PRIORITY[body.severity],
      labels: ['testbench', ...body.labels],
    }),
  );
  const issue = await jiraCall(() => jira.getIssue(created.key));

  const { id } = await trx
    .insertInto('defect.defect')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      jira_key: issue.key,
      jira_id: issue.id,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      status_category: issue.fields.status.statusCategory.key,
      severity: body.severity,
      assignee_name: issue.fields.assignee?.displayName ?? null,
      fix_version: issue.fields.fixVersions?.[0]?.name ?? null,
      jira_updated_at: issue.fields.updated,
      created_by: caller.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('defect.item_link')
    .values({
      defect_id: id,
      run_item_id: body.itemId,
      org_id: caller.orgId,
      case_id: ctx.caseId,
      linked_by: caller.userId,
    })
    .execute();
  await addEvent(
    trx,
    caller.orgId,
    id,
    'created',
    `Logged from ${ctx.caseKey} in ${ctx.runKey} (${ctx.config}, build ${ctx.build})`,
    caller.userId,
  );
  await recordEvent(trx, {
    type: 'defect.created',
    orgId: caller.orgId,
    projectId,
    actor: caller.userId,
    data: { defect_id: id, jira_key: issue.key, case_id: ctx.caseId },
  });
  return (
    await withCases(trx, jira, [
      await defectRows(trx, projectId).where('d.id', '=', id).executeTakeFirstOrThrow(),
    ])
  )[0]!;
}

/**
 * Links a run item to a bug that already exists in Jira (the duplicate check found it), and tells the
 * developer it was seen again: a repeat sighting on another build is useful signal for them.
 */
export async function linkBug(
  trx: Tx,
  jira: JiraClient,
  caller: Caller,
  projectId: string,
  webUrl: string,
  body: { runId: string; itemId: string; jiraKey: string },
): Promise<DefectRow> {
  const ctx = await itemContext(trx, projectId, body.runId, body.itemId, caller, webUrl);
  const issue = await jiraCall(() => jira.getIssue(body.jiraKey.toUpperCase()));
  if (!issue.key.startsWith(`${await projectKey(trx, projectId)}-`))
    throw badRequest(`${issue.key} belongs to another Jira project.`);

  const { id } = await trx
    .insertInto('defect.defect')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      jira_key: issue.key,
      jira_id: issue.id,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      status_category: issue.fields.status.statusCategory.key,
      assignee_name: issue.fields.assignee?.displayName ?? null,
      fix_version: issue.fields.fixVersions?.[0]?.name ?? null,
      jira_updated_at: issue.fields.updated,
      created_by: caller.userId,
    })
    .onConflict((oc) =>
      oc
        .columns(['project_id', 'jira_key'])
        .doUpdateSet({ summary: issue.fields.summary, synced_at: new Date() }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const linked = await trx
    .insertInto('defect.item_link')
    .values({
      defect_id: id,
      run_item_id: body.itemId,
      org_id: caller.orgId,
      case_id: ctx.caseId,
      linked_by: caller.userId,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('defect_id')
    .executeTakeFirst();
  if (linked) {
    await addEvent(
      trx,
      caller.orgId,
      id,
      'linked',
      `Seen again in ${ctx.caseKey}, ${ctx.runKey} (${ctx.config}, build ${ctx.build})`,
      caller.userId,
    );
    await jiraCall(() =>
      jira.comment(
        issue.key,
        commentDoc(
          `Seen again by ${caller.name} in ${ctx.caseKey} during ${ctx.runKey} on ${ctx.config}, build ${ctx.build}. ${ctx.link}`,
        ),
      ),
    );
    await recordEvent(trx, {
      type: 'defect.linked',
      orgId: caller.orgId,
      projectId,
      actor: caller.userId,
      data: { defect_id: id, jira_key: issue.key, case_id: ctx.caseId },
    });
  }
  return (
    await withCases(trx, jira, [
      await defectRows(trx, projectId).where('d.id', '=', id).executeTakeFirstOrThrow(),
    ])
  )[0]!;
}

/**
 * Applies Jira's current view of an issue to our copy. When it moves into "done", every linked case
 * gets a pending retest for the tester who linked it; the partial unique index makes a repeated
 * webhook or reconcile pass harmless.
 */
export async function applyIssue(
  trx: Tx,
  orgId: string,
  projectId: string,
  issue: JiraIssue,
  source: 'webhook' | 'reconcile',
): Promise<boolean> {
  const current = await trx
    .selectFrom('defect.defect')
    .select(['id', 'status', 'status_category'])
    .where('project_id', '=', projectId)
    .where('jira_key', '=', issue.key)
    .forUpdate()
    .executeTakeFirst();
  if (!current) return false;
  const category = issue.fields.status.statusCategory.key;
  await trx
    .updateTable('defect.defect')
    .set({
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      status_category: category,
      assignee_name: issue.fields.assignee?.displayName ?? null,
      fix_version: issue.fields.fixVersions?.[0]?.name ?? null,
      ...(issue.fields.issuetype && { issue_type: issue.fields.issuetype.name }),
      jira_updated_at: issue.fields.updated,
      synced_at: new Date(),
    })
    .where('id', '=', current.id)
    .execute();
  if (current.status === issue.fields.status.name) return false;

  await addEvent(
    trx,
    orgId,
    current.id,
    'status',
    `${current.status} → ${issue.fields.status.name} (${source === 'webhook' ? 'Jira webhook' : 'sync'})`,
    null,
  );
  if (category === 'done' && current.status_category !== 'done') {
    await sql`
      INSERT INTO defect.retest (org_id, defect_id, case_id, assignee_id)
      SELECT DISTINCT ON (l.case_id) ${orgId}::uuid, ${current.id}::uuid, l.case_id, l.linked_by
        FROM defect.item_link l WHERE l.defect_id = ${current.id}
       ORDER BY l.case_id, l.linked_at
      ON CONFLICT (defect_id, case_id) WHERE status = 'pending' DO NOTHING`.execute(trx);
    await addEvent(
      trx,
      orgId,
      current.id,
      'retest',
      'Fixed in Jira: linked cases added to the retest queue',
      null,
    );
  }
  await recordEvent(trx, {
    type: 'defect.status_changed',
    orgId,
    projectId,
    actor: null,
    data: {
      defect_id: current.id,
      jira_key: issue.key,
      from: current.status,
      to: issue.fields.status.name,
      category,
    },
  });
  return true;
}

/** Webhook entry point: finds which tenant(s) track this Jira key and applies the update in each. */
export async function handleWebhookIssue(db: Db, issue: JiraIssue): Promise<number> {
  const { rows } = await sql<{
    org_id: string;
    project_id: string;
  }>`SELECT * FROM defect.locate_jira_key(${issue.key})`.execute(db);
  for (const r of rows)
    await withTenant(db, { orgId: r.org_id, userId: SYSTEM_USER }, (trx) =>
      applyIssue(trx, r.org_id, r.project_id, issue, 'webhook'),
    );
  return rows.length;
}

/**
 * Repairs anything webhooks missed (HLD §5.4): asks Jira for linked, not-yet-done issues updated
 * since the last pass. Looks back a day beyond the bookmark because Jira evaluates JQL dates in the
 * API user's timezone; re-applying an unchanged issue is a no-op.
 */
export async function reconcileProject(
  trx: Tx,
  jira: JiraClient,
  orgId: string,
  projectId: string,
): Promise<number> {
  const state = await trx
    .selectFrom('defect.sync_state')
    .select('last_run_at')
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  const since = new Date((state?.last_run_at.getTime() ?? 0) - 86_400_000);
  const started = new Date();
  // Open defects, plus recently finished ones: a reopen whose webhook was lost must still come back.
  const open = await trx
    .selectFrom('defect.defect')
    .select('jira_key')
    .where('project_id', '=', projectId)
    .where((eb) =>
      eb.or([
        eb('status_category', '!=', 'done'),
        eb('synced_at', '>', new Date(Date.now() - 14 * 86_400_000)),
      ]),
    )
    .execute();
  let changed = 0;
  try {
    for (let i = 0; i < open.length; i += 50) {
      const keys = open.slice(i, i + 50).map((d) => d.jira_key);
      const stamp = since.toISOString().slice(0, 16).replace('T', ' ');
      const { issues } = await jira.search(
        `key in (${keys.join(', ')}) AND updated >= ${jqlString(stamp)}`,
        50,
      );
      for (const issue of issues) if (await applyIssue(trx, orgId, projectId, issue, 'reconcile')) changed++;
    }
    await trx
      .insertInto('defect.sync_state')
      .values({ project_id: projectId, org_id: orgId, last_run_at: started, last_error: null })
      .onConflict((oc) => oc.column('project_id').doUpdateSet({ last_run_at: started, last_error: null }))
      .execute();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await trx
      .insertInto('defect.sync_state')
      .values({
        project_id: projectId,
        org_id: orgId,
        last_run_at: state?.last_run_at ?? new Date(0),
        last_error: message,
      })
      .onConflict((oc) => oc.column('project_id').doUpdateSet({ last_error: message }))
      .execute();
  }
  return changed;
}

/** Background reconciler: every project with open linked defects, on an interval. */
export function startReconciler(
  db: Db,
  jira: JiraClient,
  log: { error(o: object, m: string): void },
  intervalMs = 15 * 60_000,
): () => void {
  const pass = async () => {
    const { rows } = await sql<{
      org_id: string;
      project_id: string;
    }>`SELECT * FROM defect.projects_to_reconcile()`.execute(db);
    for (const r of rows) {
      await withTenant(db, { orgId: r.org_id, userId: SYSTEM_USER }, (trx) =>
        reconcileProject(trx, jira, r.org_id, r.project_id),
      ).catch((err) => log.error({ err, projectId: r.project_id }, 'Jira reconcile failed'));
    }
  };
  const timer = setInterval(
    () => void pass().catch((err) => log.error({ err }, 'Jira reconcile pass failed')),
    intervalMs,
  );
  return () => clearInterval(timer);
}

/**
 * Records a retest on the fix build and reports back to Jira: a pass is confirmed with a comment,
 * a failure reopens the issue with the tester's note so the developer sees it immediately.
 */
export async function recordRetest(
  trx: Tx,
  jira: JiraClient,
  caller: Caller,
  projectId: string,
  retestId: string,
  body: { status: 'passed' | 'failed'; build: string; note?: string },
): Promise<void> {
  const retest = await trx
    .selectFrom('defect.retest as r')
    .innerJoin('defect.defect as d', 'd.id', 'r.defect_id')
    .innerJoin('repo.test_case as c', 'c.id', 'r.case_id')
    .select(['r.id', 'r.status', 'r.defect_id', 'd.jira_key', 'c.key_no'])
    .where('r.id', '=', retestId)
    .where('d.project_id', '=', projectId)
    .forUpdate('r')
    .executeTakeFirst();
  if (!retest) throw notFound('Retest');
  if (retest.status !== 'pending') throw badRequest('This retest is already recorded.');

  await trx
    .updateTable('defect.retest')
    .set({
      status: body.status,
      build: body.build,
      note: body.note ?? null,
      done_by: caller.userId,
      done_at: new Date(),
    })
    .where('id', '=', retestId)
    .execute();
  const key = caseKey(retest.key_no);
  const message =
    body.status === 'passed'
      ? `Verified fixed by ${caller.name}: ${key} passes on build ${body.build}.`
      : `Still failing for ${caller.name}: ${key} on build ${body.build}. ${body.note ?? ''}`.trim();
  await addEvent(trx, caller.orgId, retest.defect_id, 'retest', message, caller.userId);
  await jiraCall(async () => {
    await jira.comment(retest.jira_key, commentDoc(message));
    if (body.status === 'failed' && (await jira.transitionTo(retest.jira_key, 'To Do'))) {
      // Reflect the reopen now rather than waiting for Jira's webhook, which may never arrive.
      await applyIssue(trx, caller.orgId, projectId, await jira.getIssue(retest.jira_key), 'reconcile');
    }
  });
  await recordEvent(trx, {
    type: 'retest.completed',
    orgId: caller.orgId,
    projectId,
    actor: caller.userId,
    data: { retest_id: retestId, defect_id: retest.defect_id, status: body.status },
  });
}

// ---------- Jira issues linked to cases ----------

const linkedDirectly = (caseId: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM defect.case_link k WHERE k.defect_id = d.id AND k.case_id = ${caseId})`;
const linkedFromRun = (caseId: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM defect.item_link l WHERE l.defect_id = d.id AND l.case_id = ${caseId})`;

/**
 * Every Jira issue connected to a case, with its live status: issues linked to the case directly
 * (stories, tasks, epics, bugs) and bugs logged or linked from its failed run items.
 */
export async function caseIssues(
  trx: Tx,
  jira: JiraClient,
  projectId: string,
  caseId: string,
): Promise<CaseJiraLink[]> {
  const rows = await trx
    .selectFrom('defect.defect as d')
    .select([
      'd.id',
      'd.jira_key',
      'd.issue_type',
      'd.summary',
      'd.status',
      'd.status_category',
      'd.assignee_name',
      'd.fix_version',
      'd.synced_at',
      linkedDirectly(caseId).as('direct'),
      linkedFromRun(caseId).as('from_run'),
    ])
    .where('d.project_id', '=', projectId)
    .where(sql<boolean>`(${linkedDirectly(caseId)} OR ${linkedFromRun(caseId)})`)
    .orderBy('d.created_at', 'desc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    jiraKey: r.jira_key,
    jiraUrl: jira.browseUrl(r.jira_key),
    issueType: r.issue_type,
    summary: r.summary,
    status: r.status,
    statusCategory: r.status_category as CaseJiraLink['statusCategory'],
    assignee: r.assignee_name,
    fixVersion: r.fix_version,
    via: [...(r.direct ? (['case'] as const) : []), ...(r.from_run ? (['run'] as const) : [])],
    syncedAt: r.synced_at.toISOString(),
  }));
}

/** Links any Jira issue to a case; from then on it stays in sync like every other linked issue. */
export async function linkIssueToCase(
  trx: Tx,
  jira: JiraClient,
  caller: Caller,
  projectId: string,
  caseId: string,
  jiraKey: string,
): Promise<void> {
  const issue = await jiraCall(() => jira.getIssue(jiraKey.toUpperCase()));
  const fields = {
    summary: issue.fields.summary,
    status: issue.fields.status.name,
    status_category: issue.fields.status.statusCategory.key,
    issue_type: issue.fields.issuetype?.name ?? 'Bug',
    assignee_name: issue.fields.assignee?.displayName ?? null,
    fix_version: issue.fields.fixVersions?.[0]?.name ?? null,
    jira_updated_at: issue.fields.updated,
  };
  const { id } = await trx
    .insertInto('defect.defect')
    .values({
      org_id: caller.orgId,
      project_id: projectId,
      jira_key: issue.key,
      jira_id: issue.id,
      created_by: caller.userId,
      ...fields,
    })
    .onConflict((oc) =>
      oc.columns(['project_id', 'jira_key']).doUpdateSet({ ...fields, synced_at: new Date() }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const linked = await trx
    .insertInto('defect.case_link')
    .values({
      defect_id: id,
      case_id: caseId,
      org_id: caller.orgId,
      project_id: projectId,
      linked_by: caller.userId,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('defect_id')
    .executeTakeFirst();
  if (!linked) throw badRequest(`${issue.key} is already linked to this case.`);
  await recordEvent(trx, {
    type: 'defect.linked',
    orgId: caller.orgId,
    projectId,
    actor: caller.userId,
    data: { defect_id: id, jira_key: issue.key, case_id: caseId, direct: true },
  });
}

export async function unlinkIssueFromCase(
  trx: Tx,
  projectId: string,
  caseId: string,
  defectId: string,
): Promise<void> {
  const gone = await trx
    .deleteFrom('defect.case_link')
    .where('defect_id', '=', defectId)
    .where('case_id', '=', caseId)
    .where('project_id', '=', projectId)
    .returning('defect_id')
    .executeTakeFirst();
  if (!gone) throw notFound('Link');
}

/** The Jira project's workflow statuses, de-duplicated across issue types, in workflow order. */
export async function jiraStatuses(trx: Tx, jira: JiraClient, projectId: string): Promise<JiraStatus[]> {
  const key = await projectKey(trx, projectId);
  const types = await jiraCall(() => jira.projectStatuses(key));
  const seen = new Map<string, JiraStatus>();
  for (const t of types)
    for (const st of t.statuses)
      if (!seen.has(st.name)) seen.set(st.name, { name: st.name, category: st.statusCategory.key });
  return [...seen.values()];
}

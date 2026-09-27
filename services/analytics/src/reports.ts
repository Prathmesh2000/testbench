import {
  caseKey,
  HEALTH_KINDS,
  type BuildCompare,
  type CompareCategory,
  type Criterion,
  type Health,
  type HealthItem,
  type HealthKind,
  type Overview,
  type Readiness,
  type ResultCounts,
  type Result,
  type Workload,
} from '@tb/contracts';
import type { Tx } from '@tb/platform';
import { sql } from 'kysely';
import { classifyChange, classifyHistory, criterion, pct } from './rules';

// Reports read the live tables inside the caller's tenant transaction and are cached briefly by the
// routes. ponytail: fine to a few hundred thousand results per project; beyond that these become
// rollup tables fed by the outbox (HLD §1, Analytics) and read from the replica.

const IST = 'Asia/Kolkata';
export const STALE_DAYS = 90;
const WEEK_CAPACITY_MIN = 40 * 60;
// Cases without an estimate still take time; 10 minutes is the median estimate in our seed data.
const DEFAULT_ESTIMATE_MIN = 10;

const counts = (rows: { status: string; n: number }[]): ResultCounts => ({
  passed: rows.find((r) => r.status === 'passed')?.n ?? 0,
  failed: rows.find((r) => r.status === 'failed')?.n ?? 0,
  blocked: rows.find((r) => r.status === 'blocked')?.n ?? 0,
  skipped: rows.find((r) => r.status === 'skipped')?.n ?? 0,
});
const total = (c: ResultCounts) => c.passed + c.failed + c.blocked + c.skipped;

export async function overview(trx: Tx, projectId: string, days: number): Promise<Overview> {
  const [daily, periods, automation, defects, readyCases, retest, modules, topFailing] = await Promise.all([
    sql<{ day: string; status: string; n: number }>`
      SELECT to_char(date_trunc('day', updated_at AT TIME ZONE ${IST}), 'YYYY-MM-DD') AS day, status, count(*)::int AS n
        FROM exec.run_item
       WHERE project_id = ${projectId} AND status <> 'untested' AND updated_at >= now() - make_interval(days => ${days})
       GROUP BY 1, 2 ORDER BY 1`.execute(trx),
    sql<{ current: boolean; status: string; n: number }>`
      SELECT updated_at >= now() - make_interval(days => ${days}) AS current, status, count(*)::int AS n
        FROM exec.run_item
       WHERE project_id = ${projectId} AND status <> 'untested' AND updated_at >= now() - make_interval(days => ${days * 2})
       GROUP BY 1, 2`.execute(trx),
    sql<{ automated: number; n: number }>`
      SELECT count(*) FILTER (WHERE c.automation <> 'manual')::int AS automated, count(*)::int AS n
        FROM exec.run_item i JOIN repo.test_case c ON c.project_id = i.project_id AND c.id = i.case_id
       WHERE i.project_id = ${projectId} AND i.status <> 'untested' AND i.updated_at >= now() - make_interval(days => ${days})`.execute(
      trx,
    ),
    trx
      .selectFrom('defect.defect')
      .select(['severity', (eb) => eb.fn.countAll<number>().as('n')])
      .where('project_id', '=', projectId)
      .where('status_category', '<>', 'done')
      .groupBy('severity')
      .execute(),
    sql<{ automated: number; n: number }>`
      SELECT count(*) FILTER (WHERE automation <> 'manual')::int AS automated, count(*)::int AS n
        FROM repo.test_case WHERE project_id = ${projectId} AND status = 'ready'`.execute(trx),
    sql<{ hours: number | null }>`
      SELECT avg(extract(epoch FROM r.done_at - r.requested_at) / 3600)::float AS hours
        FROM defect.retest r JOIN defect.defect d ON d.id = r.defect_id
       WHERE d.project_id = ${projectId} AND r.done_at >= now() - make_interval(days => ${days})`.execute(
      trx,
    ),
    // Results grouped by top-level module (the first label of the ltree path).
    sql<{ name: string; status: string; n: number }>`
      SELECT t.name, i.status, count(*)::int AS n
        FROM exec.run_item i
        JOIN repo.test_case c ON c.project_id = i.project_id AND c.id = i.case_id
        JOIN repo.module m ON m.id = c.module_id
        JOIN repo.module t ON t.project_id = m.project_id AND t.path = subpath(m.path, 0, 1)
       WHERE i.project_id = ${projectId} AND i.status <> 'untested' AND i.updated_at >= now() - make_interval(days => ${days})
       GROUP BY 1, 2`.execute(trx),
    sql<{ key_no: number; title: string; fails: number; last_build: string; bug: string | null }>`
      SELECT c.key_no, c.title, f.fails, f.last_build,
             (SELECT d.jira_key FROM defect.item_link l JOIN defect.defect d ON d.id = l.defect_id
               WHERE l.case_id = c.id ORDER BY l.linked_at DESC LIMIT 1) AS bug
        FROM (SELECT i.case_id, count(*)::int AS fails,
                     (array_agg(r.build ORDER BY i.updated_at DESC))[1] AS last_build
                FROM exec.run_item i JOIN exec.run r ON r.id = i.run_id
               WHERE i.project_id = ${projectId} AND i.status = 'failed' AND i.updated_at >= now() - make_interval(days => ${days})
               GROUP BY i.case_id ORDER BY fails DESC LIMIT 8) f
        JOIN repo.test_case c ON c.project_id = ${projectId} AND c.id = f.case_id
       ORDER BY f.fails DESC`.execute(trx),
  ]);

  const current = counts(periods.rows.filter((r) => r.current));
  const previous = counts(periods.rows.filter((r) => !r.current));
  const byDay = new Map<string, { status: string; n: number }[]>();
  for (const r of daily.rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const byModule = new Map<string, { status: string; n: number }[]>();
  for (const r of modules.rows) byModule.set(r.name, [...(byModule.get(r.name) ?? []), r]);
  const sev = (s: string) => defects.find((d) => d.severity === s)?.n ?? 0;

  return {
    days,
    kpis: {
      passRate: pct(current.passed, total(current)),
      passRatePrevious: pct(previous.passed, total(previous)),
      executed: total(current),
      automatedShare: pct(automation.rows[0]!.automated, automation.rows[0]!.n),
      openDefects: defects.reduce((sum, d) => sum + d.n, 0),
      openBlockers: sev('Blocker'),
      openCriticals: sev('Critical'),
      automationCoverage: pct(readyCases.rows[0]!.automated, readyCases.rows[0]!.n),
      meanRetestHours:
        retest.rows[0]?.hours === null || retest.rows[0]?.hours === undefined
          ? null
          : Math.round(retest.rows[0].hours * 10) / 10,
    },
    daily: lastDays(days).map((day) => ({ day, ...counts(byDay.get(day) ?? []) })),
    modules: [...byModule.entries()]
      .map(([name, rows]) => ({ name, ...counts(rows) }))
      .sort((a, b) => total(b) - total(a))
      .slice(0, 12),
    topFailing: topFailing.rows.map((r) => ({
      key: caseKey(r.key_no),
      title: r.title,
      fails: r.fails,
      lastBuild: r.last_build,
      bug: r.bug,
    })),
  };
}

/** Every IST calendar day in the window, so days without results show as gaps rather than vanish. */
function lastDays(days: number): string[] {
  const out: string[] = [];
  const todayIst = new Date(Date.now() + 5.5 * 3600_000);
  for (let i = days - 1; i >= 0; i--)
    out.push(new Date(todayIst.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export async function builds(trx: Tx, projectId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('exec.run')
    .select(['build', (eb) => eb.fn.max('created_at').as('latest')])
    .where('project_id', '=', projectId)
    .groupBy('build')
    .orderBy('latest', 'desc')
    .limit(50)
    .execute();
  return rows.map((r) => r.build);
}

/**
 * The go/no-go criteria for one build (HLD §5.10). Targets are the platform defaults; a per-project
 * editor for them is a later addition.
 */
export async function readiness(trx: Tx, projectId: string, build: string | null): Promise<Readiness> {
  const all = await builds(trx, projectId);
  const b = build ?? all[0] ?? null;
  if (!b)
    return {
      build: null,
      builds: [],
      evaluatedAt: new Date().toISOString(),
      criteria: [],
      ready: false,
      signoffs: [],
    };

  const [byType, defects, needsReview, p0, retests, signoffs] = await Promise.all([
    sql<{ type: string; runs: string; passed: number; total: number }>`
      SELECT r.type, string_agg(DISTINCT 'RUN-' || r.key_no, ', ') AS runs,
             count(*) FILTER (WHERE i.status = 'passed')::int AS passed, count(*)::int AS total
        FROM exec.run r JOIN exec.run_item i ON i.run_id = r.id
       WHERE r.project_id = ${projectId} AND r.build = ${b}
       GROUP BY r.type`.execute(trx),
    trx
      .selectFrom('defect.defect')
      .select(['severity', 'jira_key'])
      .where('project_id', '=', projectId)
      .where('status_category', '<>', 'done')
      .where('severity', 'in', ['Blocker', 'Critical'])
      .execute(),
    sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM repo.test_case WHERE project_id = ${projectId} AND status = 'needs_review'`.execute(
      trx,
    ),
    sql<{ run: number; n: number }>`
      SELECT count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM exec.run_item i JOIN exec.run r ON r.id = i.run_id
                WHERE i.project_id = c.project_id AND i.case_id = c.id AND r.build = ${b} AND i.status <> 'untested'))::int AS run,
             count(*)::int AS n
        FROM repo.test_case c WHERE c.project_id = ${projectId} AND c.priority = 'P0' AND c.status = 'ready'`.execute(
      trx,
    ),
    sql<{ pending: number; old: number }>`
      SELECT count(*)::int AS pending, count(*) FILTER (WHERE r.requested_at < now() - interval '24 hours')::int AS old
        FROM defect.retest r JOIN defect.defect d ON d.id = r.defect_id
       WHERE d.project_id = ${projectId} AND r.status = 'pending'`.execute(trx),
    trx
      .selectFrom('analytics.signoff as s')
      .innerJoin('iam.app_user as u', 'u.id', 's.decided_by')
      .select(['s.decision', 's.note', 's.decided_at', 'u.name'])
      .where('s.project_id', '=', projectId)
      .where('s.build', '=', b)
      .orderBy('s.decided_at', 'desc')
      .execute(),
  ]);

  const type = (t: string) => byType.rows.find((r) => r.type === t);
  const smoke = type('smoke');
  const regression = type('regression');
  const blockers = defects.filter((d) => d.severity === 'Blocker');
  const criticals = defects.filter((d) => d.severity === 'Critical');
  const p0Row = p0.rows[0]!;
  const r = retests.rows[0]!;
  const keys = (list: { jira_key: string }[]) =>
    list
      .map((d) => d.jira_key)
      .slice(0, 5)
      .join(', ') || 'None open';

  const criteria: Criterion[] = [
    criterion(
      'smoke',
      'Smoke pass rate',
      smoke ? pct(smoke.passed, smoke.total) : null,
      '>=',
      100,
      '%',
      smoke
        ? `${smoke.total - smoke.passed} of ${smoke.total} not passed in ${smoke.runs}`
        : `No smoke run on build ${b}`,
    ),
    criterion('blockers', 'Open Blocker bugs', blockers.length, '<=', 0, '', keys(blockers)),
    criterion(
      'needs_review',
      'Needs-review cases',
      needsReview.rows[0]!.n,
      '<=',
      10,
      '',
      'Cases whose linked requirement changed',
    ),
    criterion(
      'regression',
      'Regression pass rate',
      regression ? pct(regression.passed, regression.total) : null,
      '>=',
      95,
      '%',
      regression ? `${regression.runs} on build ${b}` : `No regression run on build ${b}`,
    ),
    criterion(
      'p0',
      'P0 coverage',
      p0Row.n ? pct(p0Row.run, p0Row.n) : null,
      '>=',
      100,
      '%',
      `${p0Row.run} of ${p0Row.n} Ready P0 cases run on ${b}`,
    ),
    criterion('criticals', 'Open Critical bugs', criticals.length, '<=', 3, '', keys(criticals)),
    criterion('retest_age', 'Retest queue older than 24 h', r.old, '<=', 0, '', `${r.pending} pending`),
  ];
  return {
    build: b,
    builds: all,
    evaluatedAt: new Date().toISOString(),
    criteria,
    ready: criteria.every((c) => c.status === 'met'),
    signoffs: signoffs.map((s) => ({
      decision: s.decision as 'go' | 'no_go',
      note: s.note,
      by: s.name,
      at: s.decided_at.toISOString(),
    })),
  };
}

const KIND_ORDER = Object.fromEntries(HEALTH_KINDS.map((k, i) => [k, i])) as Record<HealthKind, number>;

/** Stale, always failing, flaky and needs-review cases (HLD §5.16). */
export async function health(trx: Tx, projectId: string): Promise<Health> {
  const [histories, stale, review] = await Promise.all([
    // The last 10 decisive results per case from the past 180 days; older history can't flip a verdict.
    sql<{ case_id: string; statuses: ('passed' | 'failed')[] }>`
      SELECT case_id, array_agg(status ORDER BY rn) AS statuses FROM (
        SELECT case_id, status, row_number() OVER (PARTITION BY case_id ORDER BY updated_at DESC) AS rn
          FROM exec.run_item
         WHERE project_id = ${projectId} AND status IN ('passed', 'failed') AND updated_at >= now() - interval '180 days'
      ) h WHERE rn <= 10 GROUP BY case_id`.execute(trx),
    sql<{ id: string; days: number | null }>`
      SELECT id, (extract(epoch FROM now() - last_run_at) / 86400)::int AS days
        FROM repo.test_case
       WHERE project_id = ${projectId} AND status IN ('ready', 'in_review')
         AND coalesce(last_run_at, created_at) < now() - make_interval(days => ${STALE_DAYS})`.execute(trx),
    sql<{ id: string; reason: string | null }>`
      SELECT c.id, (SELECT f.reason FROM docs.case_flag f WHERE f.case_id = c.id ORDER BY f.flagged_at DESC LIMIT 1) AS reason
        FROM repo.test_case c WHERE c.project_id = ${projectId} AND c.status = 'needs_review'`.execute(trx),
  ]);

  const found: { caseId: string; kind: HealthKind; why: string }[] = [];
  for (const h of histories.rows) {
    const v = classifyHistory(h.statuses);
    const failedOf = h.statuses.filter((s) => s === 'failed').length;
    if (v.alwaysFailing)
      found.push({
        caseId: h.case_id,
        kind: 'always_failing',
        why: `Failed ${failedOf} of last ${h.statuses.length} runs`,
      });
    else if (v.flaky)
      found.push({
        caseId: h.case_id,
        kind: 'flaky',
        why: `Passed ${h.statuses.length - failedOf}, failed ${failedOf} in last ${h.statuses.length} · ${v.flips} flips`,
      });
  }
  for (const r of review.rows)
    found.push({ caseId: r.id, kind: 'needs_review', why: r.reason ?? 'Marked Needs review' });
  for (const s of stale.rows)
    found.push({
      caseId: s.id,
      kind: 'stale',
      why: s.days === null ? 'Never run' : `Not run in ${s.days} days`,
    });

  const countsByKind = Object.fromEntries(
    HEALTH_KINDS.map((k) => [k, found.filter((f) => f.kind === k).length]),
  ) as Health['counts'];
  const top = found.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).slice(0, 200);
  const cases = top.length
    ? await trx
        .selectFrom('repo.test_case as c')
        .leftJoin('iam.app_user as u', 'u.id', 'c.owner_id')
        .select(['c.id', 'c.key_no', 'c.title', 'u.id as owner_id', 'u.name as owner_name'])
        .where('c.project_id', '=', projectId)
        .where('c.id', 'in', [...new Set(top.map((t) => t.caseId))])
        .execute()
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  const items: HealthItem[] = top.flatMap((t) => {
    const c = byId.get(t.caseId);
    if (!c) return [];
    return [
      {
        kind: t.kind,
        key: caseKey(c.key_no),
        title: c.title,
        why: t.why,
        owner: c.owner_id ? { id: c.owner_id, name: c.owner_name! } : null,
      },
    ];
  });
  return { staleDays: STALE_DAYS, counts: countsByKind, items };
}

const COMPARE_ROW_CAP = 2_000;

/** Result per case and configuration on two builds, latest item on each (HLD §5.16). */
export async function compareBuilds(
  trx: Tx,
  projectId: string,
  base: string,
  head: string,
): Promise<BuildCompare> {
  const [pairs, all] = await Promise.all([
    sql<{ case_id: string; config: string; base: Result | null; head: Result | null }>`
      WITH b AS (
        SELECT DISTINCT ON (i.case_id, i.config) i.case_id, i.config, i.status
          FROM exec.run_item i JOIN exec.run r ON r.id = i.run_id
         WHERE i.project_id = ${projectId} AND r.build = ${base}
         ORDER BY i.case_id, i.config, i.updated_at DESC
      ), h AS (
        SELECT DISTINCT ON (i.case_id, i.config) i.case_id, i.config, i.status
          FROM exec.run_item i JOIN exec.run r ON r.id = i.run_id
         WHERE i.project_id = ${projectId} AND r.build = ${head}
         ORDER BY i.case_id, i.config, i.updated_at DESC
      )
      SELECT coalesce(b.case_id, h.case_id) AS case_id, coalesce(b.config, h.config) AS config,
             b.status AS base, h.status AS head
        FROM b FULL JOIN h ON h.case_id = b.case_id AND h.config = b.config`.execute(trx),
    builds(trx, projectId),
  ]);

  const changed = pairs.rows.flatMap((p) => {
    const category = classifyChange(p.base, p.head);
    return category ? [{ ...p, category }] : [];
  });
  const countsByCat = { new_failure: 0, fixed: 0, still_failing: 0, added: 0, not_run: 0 } as Record<
    CompareCategory,
    number
  >;
  for (const c of changed) countsByCat[c.category]++;
  const shown = changed.slice(0, COMPARE_ROW_CAP);
  const cases = shown.length
    ? await trx
        .selectFrom('repo.test_case as c')
        .select((eb) => [
          'c.id',
          'c.key_no',
          'c.title',
          eb
            .selectFrom('defect.item_link as l')
            .innerJoin('defect.defect as d', 'd.id', 'l.defect_id')
            .select('d.jira_key')
            .whereRef('l.case_id', '=', 'c.id')
            .orderBy('l.linked_at', 'desc')
            .limit(1)
            .as('bug'),
        ])
        .where('c.project_id', '=', projectId)
        .where('c.id', 'in', [...new Set(shown.map((s) => s.case_id))])
        .execute()
    : [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  return {
    base,
    head,
    builds: all,
    counts: countsByCat,
    compared: pairs.rows.length,
    rows: shown.flatMap((s) => {
      const c = byId.get(s.case_id);
      return c
        ? [
            {
              key: caseKey(c.key_no),
              title: c.title,
              config: s.config,
              base: s.base,
              head: s.head,
              category: s.category,
              bug: c.bug,
            },
          ]
        : [];
    }),
  };
}

/** Open work per tester in active runs against a 40-hour week, and how good their estimates have been. */
export async function workload(trx: Tx, projectId: string): Promise<Workload> {
  const [open, accuracy] = await Promise.all([
    sql<{ user_id: string | null; name: string | null; items: number; estimate: number }>`
      SELECT i.assignee_id AS user_id, u.name, count(*)::int AS items,
             sum(coalesce(c.estimate_min, ${DEFAULT_ESTIMATE_MIN}))::int AS estimate
        FROM exec.run_item i
        JOIN exec.run r ON r.id = i.run_id
        JOIN repo.test_case c ON c.project_id = i.project_id AND c.id = i.case_id
        LEFT JOIN iam.app_user u ON u.id = i.assignee_id
       WHERE i.project_id = ${projectId} AND r.status = 'active' AND i.status = 'untested'
       GROUP BY 1, 2`.execute(trx),
    sql<{ user_id: string; estimated: number; actual: number }>`
      SELECT i.assignee_id AS user_id,
             sum(coalesce(c.estimate_min, ${DEFAULT_ESTIMATE_MIN}) * 60)::int AS estimated, sum(i.duration_s)::int AS actual
        FROM exec.run_item i JOIN repo.test_case c ON c.project_id = i.project_id AND c.id = i.case_id
       WHERE i.project_id = ${projectId} AND i.status <> 'untested' AND i.duration_s > 0
         AND i.assignee_id IS NOT NULL AND i.updated_at >= now() - interval '30 days'
       GROUP BY 1`.execute(trx),
  ]);
  const acc = new Map(
    accuracy.rows.map((a) => [a.user_id, a.actual ? Math.round((a.estimated / a.actual) * 100) : null]),
  );
  return {
    rows: open.rows
      .filter((r): r is typeof r & { user_id: string; name: string } => r.user_id !== null)
      .map((r) => ({
        user: { id: r.user_id, name: r.name },
        items: r.items,
        estimateMin: r.estimate,
        capacityMin: WEEK_CAPACITY_MIN,
        accuracy: acc.get(r.user_id) ?? null,
      }))
      .sort((a, b) => b.estimateMin - a.estimateMin),
    unassigned: open.rows.find((r) => r.user_id === null)?.items ?? 0,
  };
}

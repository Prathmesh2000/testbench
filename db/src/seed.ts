import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { ownerDatabaseUrl } from './env';
import { CONDITIONS, CONFIGS, LABELS, MODULE_TREE, PEOPLE, TYPES, VERBS, makeSteps, prng, type SeedStep } from './fixtures';

// Local development seed. Runs as the owner role, so it writes across tenants without RLS getting in the
// way — which is exactly why it must never be pointed at a shared database. It wipes all app data first.

const SIZES = { demo: 1_000, dev: 100_000 } as const;
const BATCH = 1_000;

type Row = Record<string, unknown>;

const { values } = parseArgs({ options: { size: { type: 'string', default: 'demo' } } });
const size = values.size as keyof typeof SIZES;
if (!(size in SIZES)) throw new Error(`--size must be one of: ${Object.keys(SIZES).join(', ')}`);

const rand = prng(20260927);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const weighted = <T>(pairs: [T, number][]): T => {
  let r = rand() * pairs.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, w] of pairs) if ((r -= w) <= 0) return value;
  return pairs[0]![0];
};
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const ltreeLabel = (id: string) => id.replaceAll('-', '');

const db = new Kysely<any>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: ownerDatabaseUrl(), max: 4 }) }),
});

async function insertBatched(table: string, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insertInto(table).values(rows.slice(i, i + BATCH)).execute();
  }
}

async function reset(): Promise<void> {
  await sql`TRUNCATE outbox.event, exec.evidence, exec.step_result, exec.run_item, exec.run,
    repo.bulk_job, repo.module_stats, repo.case_dependency, repo.case_version, repo.test_case, repo.module,
    repo.project, iam.membership, iam.app_user, iam.org CASCADE`.execute(db);
}

async function seed(): Promise<void> {
  const started = Date.now();
  const caseCount = SIZES[size];
  await reset();

  const orgId = randomUUID();
  await db.insertInto('iam.org').values({ id: orgId, slug: 'paytrail', name: 'Paytrail' }).execute();

  const users = PEOPLE.map((p) => ({ ...p, id: randomUUID() }));
  await insertBatched('iam.app_user', users.map(({ id, email, name }) => ({ id, email, name })));

  const projectId = randomUUID();
  await db.insertInto('repo.project')
    .values({ id: projectId, org_id: orgId, key: 'PAY', name: 'Payments web', next_case_no: 10001 + caseCount, next_run_no: 4 })
    .execute();

  // Aarav is a tester on PAY only, to exercise project-scoped roles; everyone else holds an org-wide role.
  await insertBatched('iam.membership', users.map((u) => ({
    org_id: orgId, user_id: u.id, role: u.role, project_id: u.email.startsWith('aarav.') ? projectId : null,
  })));

  // Module tree: top-level modules, each with leaves.
  const modules: Row[] = [];
  const leaves: { id: string; path: string; behaviours: string[]; weight: number }[] = [];
  Object.entries(MODULE_TREE).forEach(([topName, children], topPos) => {
    const topId = randomUUID();
    modules.push({ id: topId, org_id: orgId, project_id: projectId, parent_id: null, name: topName, path: ltreeLabel(topId), position: topPos });
    Object.entries(children).forEach(([leafName, behaviours], pos) => {
      const id = randomUUID();
      modules.push({ id, org_id: orgId, project_id: projectId, parent_id: topId, name: leafName, path: `${ltreeLabel(topId)}.${ltreeLabel(id)}`, position: pos });
      leaves.push({ id, path: `${topName} / ${leafName}`, behaviours, weight: 0.4 + rand() * 1.6 });
    });
  });
  await insertBatched('repo.module', modules);

  const owners = users.filter((u) => u.role === 'tester' || u.role === 'test_lead');
  const totalWeight = leaves.reduce((s, l) => s + l.weight, 0);
  const pickLeaf = () => {
    let r = rand() * totalWeight;
    for (const leaf of leaves) if ((r -= leaf.weight) <= 0) return leaf;
    return leaves[leaves.length - 1]!;
  };

  interface SeedCase { id: string; keyNo: number; leafPath: string; labels: string[]; steps: SeedStep[]; version: number; title: string }
  const cases: SeedCase[] = [];
  let caseRows: Row[] = [];
  let versionRows: Row[] = [];
  const flush = async () => {
    await insertBatched('repo.test_case', caseRows);
    await insertBatched('repo.case_version', versionRows);
    caseRows = [];
    versionRows = [];
  };

  for (let i = 0; i < caseCount; i++) {
    const leaf = pickLeaf();
    const behaviour = pick(leaf.behaviours);
    const condition = pick(CONDITIONS);
    const title = `${pick(VERBS)} ${behaviour}${condition ? ` ${condition}` : ''}`;
    const labels = [...new Set(Array.from({ length: weighted([[0, 35], [1, 40], [2, 20], [3, 5]]) }, () => pick(LABELS)))];
    const versions = weighted([[1, 55], [2, 30], [3, 15]]);
    const steps = makeSteps(rand, leaf.path, behaviour);
    const id = randomUUID();
    const updated = daysAgo(Math.floor(rand() * 200));

    caseRows.push({
      id, org_id: orgId, project_id: projectId, key_no: 10001 + i, module_id: leaf.id, title,
      priority: weighted([['P0', 8], ['P1', 22], ['P2', 45], ['P3', 25]]),
      type: pick(TYPES),
      status: weighted([['ready', 70], ['in_review', 8], ['draft', 10], ['needs_review', 7], ['obsolete', 5]]),
      owner_id: pick(owners).id, labels,
      estimate_min: pick([2, 3, 5, 5, 8, 10, 15, 20]),
      automation: weighted([['manual', 60], ['automated', 35], ['flaky', 5]]),
      last_result: weighted([['passed', 62], ['failed', 9], ['blocked', 4], ['skipped', 3], ['untested', 22]]),
      current_version: versions, created_by: pick(owners).id, created_at: daysAgo(400), updated_at: updated,
    });
    // Older versions differ slightly (one fewer step, older wording), so the version diff has something to show.
    for (let v = 1; v <= versions; v++) {
      const isCurrent = v === versions;
      versionRows.push({
        project_id: projectId, case_id: id, version: v, org_id: orgId,
        title: isCurrent ? title : title.replace(/^(\w+)/, 'Test'),
        preconditions: 'Merchant “QA Test Store” is onboarded on Staging-IN with UPI enabled.',
        format: rand() < 0.15 ? 'gherkin' : 'steps',
        steps: JSON.stringify(isCurrent ? steps : steps.slice(0, Math.max(2, steps.length - 1))),
        note: v === 1 ? 'Created' : 'Updated expected results after review',
        author_id: pick(owners).id, created_at: daysAgo(400 - v * 30),
      });
    }
    cases.push({ id, keyNo: 10001 + i, leafPath: leaf.path, labels, steps, version: versions, title });
    if (caseRows.length >= BATCH * 5) await flush();
  }
  await flush();

  // A handful of prerequisites: smoke cases depend on a login case passing first.
  const login = cases.find((c) => c.leafPath === 'Auth / Login') ?? cases[0]!;
  const dependents = cases.filter((c) => c.labels.includes('smoke') && c.id !== login.id).slice(0, 40);
  await insertBatched('repo.case_dependency', dependents.map((c) => ({ org_id: orgId, project_id: projectId, case_id: c.id, depends_on_id: login.id })));

  await seedRuns(orgId, projectId, users, cases, login.id);

  console.log(`seeded ${caseCount.toLocaleString('en-IN')} cases (${size}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('sign in as sneha.iyer@paytrail.in / Testbench@123 (test lead); see README for the other accounts');
}

/** Three runs in different states, with results consistent with their counters. */
async function seedRuns(
  orgId: string,
  projectId: string,
  users: { id: string; email: string }[],
  cases: { id: string; version: number; labels: string[]; steps: SeedStep[] }[],
  loginCaseId: string,
): Promise<void> {
  const me = users.find((u) => u.email.startsWith('sneha.'))!;
  const testers = users.filter((u) => /^(sneha|aarav|priya|rohan)\./.test(u.email));
  const smoke = [cases.find((c) => c.id === loginCaseId)!, ...cases.filter((c) => c.labels.includes('smoke') && c.id !== loginCaseId)];
  const plans = [
    { keyNo: 1, name: 'Release 4.17 smoke — Payments web', type: 'smoke', build: '8766', status: 'completed', cases: smoke.slice(0, 60), configs: CONFIGS.slice(0, 2), done: 1 },
    { keyNo: 2, name: 'Nightly regression — UPI', type: 'regression', build: '8812', status: 'active', cases: cases.slice(0, 200), configs: CONFIGS.slice(0, 1), done: 0.8 },
    { keyNo: 3, name: 'Release 4.18 smoke — Payments web', type: 'smoke', build: '8812', status: 'active', cases: smoke.slice(0, 84), configs: CONFIGS.slice(0, 2), done: 0.6 },
  ];

  for (const plan of plans) {
    const runId = randomUUID();
    const items: Row[] = [];
    const results: Row[] = [];
    const counts = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
    let position = 0;
    for (const c of plan.cases) {
      for (const config of plan.configs) {
        const itemId = randomUUID();
        const executed = rand() < plan.done;
        let status = 'untested';
        let stepStatus: string[] = [];
        if (executed) {
          status = weighted([['passed', 86], ['failed', 8], ['blocked', 4], ['skipped', 2]]);
          stepStatus = c.steps.map(() => (status === 'failed' || status === 'blocked' ? 'passed' : status));
          if (status === 'failed' || status === 'blocked') stepStatus[stepStatus.length - 1] = status;
          counts[status as keyof typeof counts]++;
          stepStatus.forEach((s, stepIndex) => results.push({
            org_id: orgId, run_item_id: itemId, step_index: stepIndex, status: s,
            actual: s === 'failed' ? 'Status stayed PENDING after 60 seconds' : null,
            recorded_by: me.id, recorded_at: daysAgo(plan.status === 'completed' ? 12 : rand() * 2),
          }));
        }
        items.push({
          id: itemId, org_id: orgId, project_id: projectId, run_id: runId, case_id: c.id, case_version: c.version,
          config, position: position++, assignee_id: testers[position % testers.length]!.id, status,
          step_status: JSON.stringify(stepStatus), duration_s: executed ? 60 + Math.floor(rand() * 400) : 0,
        });
      }
    }
    await db.insertInto('exec.run').values({
      id: runId, org_id: orgId, project_id: projectId, key_no: plan.keyNo, name: plan.name, type: plan.type,
      environment: 'Staging-IN', build: plan.build, configs: plan.configs, status: plan.status,
      due_at: plan.status === 'active' ? daysAgo(-2) : null, total: items.length, ...counts,
      created_by: me.id, created_at: daysAgo(plan.status === 'completed' ? 14 : 1),
    }).execute();
    await insertBatched('exec.run_item', items);
    await insertBatched('exec.step_result', results);
  }
}

try {
  await seed();
} finally {
  await db.destroy();
}

import type { AutoStep, GraphWorkflow, SiteGraph, SitePage, SitePageBody, StudioComponent, WorkflowPlan } from '@tb/contracts';
import { FieldRules as FieldRulesSchema, WorkflowPlan as PlanSchema } from '@tb/contracts';
import type { Tx } from '@tb/platform';
import { identifier } from './intent/build';
import { fieldKind } from './intent/variations';
import { listComponents, testKey } from './tests';

// The site map (contracts/site.ts): pages the Test Browser reached, merged by stable path, and the
// saved workflows that join them. No page content is trusted: it came from the site under test.

const ID_SEGMENT = /\d{2,}|^[0-9a-f]{8,}$/i;
const LIMITS = { headings: 30, actions: 120, fields: 60, apis: 80 };

/** A page's stable path: no query, ids made ":id", no trailing slash. */
export function pagePath(url: string): string {
  try {
    const segs = new URL(url).pathname.split('/').map((s) => (s && ID_SEGMENT.test(s) ? ':id' : s));
    const p = segs.join('/').replace(/\/+$/, '');
    return (p || '/').slice(0, 500);
  } catch {
    return '/';
  }
}

/** A workflow's page path as the recording kept it (cut at the first id, see build.ts), in the same form. */
export function recordedPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return `${path}:id`;
  return path || '/';
}

type Stored = Omit<SitePage, 'id' | 'path' | 'visits' | 'firstSeen' | 'lastSeen'>;

/**
 * Links to one kind of page (/projects/:id) are named by the data they point at, a project each: a
 * few are kept as examples, or every visit after a test run would add its new ones.
 */
export function examplesOnly(actions: Stored['actions'], keep = 3): Stored['actions'] {
  const seen = new Map<string, number>();
  return actions.filter((a) => {
    if (!a.to?.includes(':id')) return true;
    const n = (seen.get(a.to) ?? 0) + 1;
    seen.set(a.to, n);
    return n <= keep;
  });
}

function merge(before: Stored | null, body: SitePageBody, origin: string): Stored {
  const keys = new Set<string>();
  const actions = body.actions.map((a) => {
    let to: string | null = null;
    if (a.href) {
      try {
        const u = new URL(a.href);
        // Only links within the site join its pages; others are just buttons that leave.
        if (u.origin === origin) to = pagePath(a.href);
      } catch {
        to = null;
      }
    }
    return { label: a.label, role: a.role, to };
  });
  const fields = body.fields.map((f) => ({ key: identifier(f.label, keys, 'field'), label: f.label, kind: fieldKind({ label: f.label, rules: f.rules }), rules: f.rules }));
  const union = <T,>(a: T[], b: T[], key: (x: T) => string, max: number) => {
    const out = new Map<string, T>();
    for (const x of [...b, ...a]) if (!out.has(key(x))) out.set(key(x), x);
    return [...out.values()].slice(0, max);
  };
  return {
    title: body.title || before?.title || '',
    headings: union(before?.headings ?? [], body.headings, (h) => h, LIMITS.headings),
    actions: examplesOnly(union(before?.actions ?? [], actions, (a) => `${a.role}|${a.label}`, LIMITS.actions)),
    fields: union(before?.fields ?? [], fields, (f) => f.label, LIMITS.fields),
    apis: union(before?.apis ?? [], body.apis, (x) => `${x.method} ${x.path} ${x.status}`, LIMITS.apis),
  };
}

/** Keeps what the Test Browser saw on a page, merged with every visit before. */
export async function savePage(trx: Tx, orgId: string, projectId: string, body: SitePageBody): Promise<SitePage> {
  const origin = URL.canParse(body.url) ? new URL(body.url).origin : '';
  const path = pagePath(body.url);
  const row = await trx.selectFrom('studio.site_page').selectAll().where('project_id', '=', projectId).where('path', '=', path).forUpdate().executeTakeFirst();
  const next = merge(row ? (row.body as unknown as Stored) : null, body, origin);
  const saved = row
    ? await trx
        .updateTable('studio.site_page')
        .set({ body: JSON.stringify(next), visits: row.visits + 1, last_seen: new Date() })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow()
    : await trx
        .insertInto('studio.site_page')
        .values({ org_id: orgId, project_id: projectId, path, body: JSON.stringify(next) })
        .returningAll()
        .executeTakeFirstOrThrow();
  return toPage(saved);
}

const toPage = (r: { id: string; path: string; body: Record<string, unknown>; visits: number; first_seen: Date; last_seen: Date }): SitePage => ({
  id: r.id,
  path: r.path,
  ...(r.body as unknown as Stored),
  visits: r.visits,
  firstSeen: r.first_seen.toISOString(),
  lastSeen: r.last_seen.toISOString(),
});

export async function listPages(trx: Tx, projectId: string): Promise<SitePage[]> {
  const rows = await trx.selectFrom('studio.site_page').selectAll().where('project_id', '=', projectId).orderBy('path').limit(500).execute();
  return rows.map(toPage);
}

export async function getPlan(trx: Tx, projectId: string, workflowId: string): Promise<WorkflowPlan> {
  const row = await trx.selectFrom('studio.workflow_plan').select('body').where('project_id', '=', projectId).where('component_id', '=', workflowId).executeTakeFirst();
  const parsed = PlanSchema.safeParse(row?.body ?? {});
  return parsed.success ? parsed.data : PlanSchema.parse({});
}

export async function savePlan(trx: Tx, caller: { orgId: string; userId: string }, projectId: string, workflowId: string, plan: WorkflowPlan): Promise<WorkflowPlan> {
  await trx
    .insertInto('studio.workflow_plan')
    .values({ component_id: workflowId, org_id: caller.orgId, project_id: projectId, body: JSON.stringify(plan), updated_by: caller.userId })
    .onConflict((oc) => oc.column('component_id').doUpdateSet({ body: JSON.stringify(plan), updated_by: caller.userId, updated_at: new Date() }))
    .execute();
  return plan;
}

/** Which tests run a component, from their current versions' steps. */
async function usage(trx: Tx, projectId: string): Promise<Map<string, GraphWorkflow['usedBy']>> {
  const rows = await trx
    .selectFrom('studio.test as t')
    .innerJoin('studio.test_version as v', (j) => j.onRef('v.test_id', '=', 't.id').onRef('v.version', '=', 't.current_version'))
    .select(['t.id', 't.key_no', 't.title', 't.case_id', 'v.steps'])
    .where('t.project_id', '=', projectId)
    .where('t.status', '!=', 'archived')
    .execute();
  const out = new Map<string, GraphWorkflow['usedBy']>();
  for (const r of rows)
    for (const s of r.steps as AutoStep[])
      if (s.action === 'use_component' && s.component) {
        const list = out.get(s.component.id) ?? [];
        if (!list.some((u) => u.testId === r.id)) list.push({ testId: r.id, key: testKey(r.key_no), title: r.title, caseId: r.case_id });
        out.set(s.component.id, list);
      }
  return out;
}

/** The first thing a workflow presses on its start page: the button that starts it. */
function startAction(c: StudioComponent): string | null {
  const s = c.steps.find((x) => x.action === 'click' || x.action === 'press');
  const l = s?.target && 'locator' in s.target ? s.target.locator : null;
  return l ? (l.name ?? l.value) : null;
}

/** Pages, the workflows between them, and plain links, with what is checked and where it is used. */
export async function siteGraph(trx: Tx, projectId: string): Promise<SiteGraph> {
  const [pages, components, used, plans] = await Promise.all([
    listPages(trx, projectId),
    listComponents(trx, projectId),
    usage(trx, projectId),
    trx.selectFrom('studio.workflow_plan').select(['component_id', 'body']).where('project_id', '=', projectId).execute(),
  ]);
  const planOf = new Map(plans.map((p) => [p.component_id, PlanSchema.safeParse(p.body)]));
  const workflows: GraphWorkflow[] = components
    .filter((c) => c.meta.origin === 'workflow' && !c.meta.archived)
    .map((c) => {
      const plan = planOf.get(c.id);
      const saved = plan?.success ? plan.data : PlanSchema.parse({});
      const paths = c.meta.pages.map((p) => recordedPath(p.path));
      const continuation = c.meta.continuationId ? components.find((x) => x.id === c.meta.continuationId) : undefined;
      const fields = c.inputs.flatMap((k) => {
        const f = c.meta.pages.flatMap((p) => p.fields).find((x) => x.key === k);
        const rules = c.meta.inputRules[k] ?? f?.rules;
        return rules ? [{ key: k, label: f?.label ?? k, kind: f?.kind ?? c.meta.inputKinds[k] ?? 'text', rules, recorded: c.meta.defaults[k] ?? '', secret: c.meta.secretInputs.includes(k) }] : [];
      });
      return {
        id: c.id,
        kind: 'workflow' as const,
        name: c.name,
        version: c.version,
        intent: c.meta.intent,
        from: paths[0] ?? '/',
        to: paths.at(-1) ?? paths[0] ?? '/',
        startAction: startAction(c),
        prerequisiteId: c.meta.prerequisiteId,
        fields,
        apis: c.meta.apis,
        scenarios: saved.scenarios.map((s) => ({
          id: s.id,
          title: s.title,
          kind: s.kind,
          status: s.status,
          expect: { outcome: s.expect.outcome, message: s.expect.message, fieldErrors: s.expect.fieldErrors, stop: s.expect.stop, checks: s.expect.checks },
        })),
        checks: saved.checks,
        usedBy: [...new Map([...(used.get(c.id) ?? []), ...(continuation ? (used.get(continuation.id) ?? []) : [])].map((u) => [u.testId, u])).values()],
      };
    });
  // A prerequisite (signing in) belongs on the map too: from the page it opens to where the workflows
  // that run it start. One kept only as a segment has no pages of its own, so that is all it can say.
  for (const c of components.filter((x) => x.meta.origin === 'prerequisite' || (x.meta.origin !== 'workflow' && workflows.some((w) => w.prerequisiteId === x.id)))) {
    const after = workflows.filter((w) => w.prerequisiteId === c.id);
    if (!after.length) continue;
    const open = c.steps.find((s) => s.action === 'open')?.value ?? '';
    const from = recordedPath(open.replace(/^\{env\.baseUrl\}/, '').split(/[?#]/)[0] || '/');
    workflows.push({
      id: c.id,
      kind: 'prerequisite',
      name: c.name,
      version: c.version,
      intent: c.meta.purpose || c.description,
      from,
      to: after[0]!.from,
      startAction: startAction(c),
      prerequisiteId: null,
      fields: c.inputs.map((k) => ({ key: k, label: k, kind: c.meta.inputKinds[k] ?? 'text', rules: FieldRulesSchema.parse({}), recorded: c.meta.defaults[k] ?? '', secret: c.meta.secretInputs.includes(k) })),
      apis: c.meta.apis,
      scenarios: [],
      checks: [],
      usedBy: used.get(c.id) ?? [],
    });
  }
  // Pages a workflow went through but the Test Browser has not reported yet still belong on the map.
  const known = new Map(pages.map((p) => [p.path, p]));
  for (const c of components.filter((x) => x.meta.origin === 'workflow' && !x.meta.archived))
    for (const p of c.meta.pages) {
      const path = recordedPath(p.path);
      if (known.has(path)) continue;
      known.set(path, {
        id: `wf:${c.id}:${path}`,
        path,
        title: p.title,
        headings: p.headings,
        actions: p.actions.map((a) => ({ label: a.label, role: 'button' as const, to: null })),
        fields: p.fields,
        apis: [],
        visits: 0,
        firstSeen: c.updatedAt,
        lastSeen: c.updatedAt,
      });
    }
  const links: SiteGraph['links'] = [];
  for (const p of known.values())
    for (const a of p.actions)
      if (a.to && a.to !== p.path && known.has(a.to) && !links.some((l) => l.from === p.path && l.to === a.to)) links.push({ from: p.path, to: a.to, label: a.label });
  return { pages: [...known.values()], workflows, links: links.slice(0, 400) };
}

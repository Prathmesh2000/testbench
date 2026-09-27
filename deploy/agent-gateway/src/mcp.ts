import type {
  CaseDetail,
  DocumentDetail,
  DocumentSummary,
  ModuleNode,
  RunItemRow,
  RunSummary,
  SearchResult,
  Traceability,
} from '@tb/contracts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreError, type CoreClient } from './core';

// The MCP tools (HLD §5.8). Each tool is a thin wrapper over the public API, called as the user whose
// token the agent presented, and answers with compact text an agent can read plus the raw JSON.

const project = z
  .string()
  .max(20)
  .optional()
  .describe('Project key, e.g. PAY. Optional when you have one project.');

const text = (summary: string, data?: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`,
    },
  ],
});

/** Tool errors go back to the agent as readable results rather than protocol failures, so it can correct itself. */
async function guarded(fn: () => Promise<ReturnType<typeof text>>) {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof CoreError ? err.message : err instanceof Error ? err.message : String(err);
    return { ...text(`Error: ${message}`), isError: true };
  }
}

/** "Payments / UPI" (or a module id) to the module's id. */
function findModule(modules: ModuleNode[], wanted: string): ModuleNode | undefined {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const path = (m: ModuleNode): string =>
    m.parentId && byId.get(m.parentId) ? `${path(byId.get(m.parentId)!)} / ${m.name}` : m.name;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s*[/›>]\s*/g, ' / ')
      .trim();
  return (
    byId.get(wanted) ??
    modules.find((m) => norm(path(m)) === norm(wanted)) ??
    modules.find((m) => norm(m.name) === norm(wanted))
  );
}

async function findRun(core: CoreClient, projectId: string, key: string): Promise<RunSummary> {
  const runs = await core.get<RunSummary[]>(`/projects/${projectId}/runs`);
  const run = runs.find((r) => r.key.toLowerCase() === key.toLowerCase());
  if (!run) throw new CoreError(404, `No run ${key}.`);
  return run;
}

export function buildMcpServer(core: CoreClient): McpServer {
  const server = new McpServer({ name: 'testbench', version: '1.0.0' });

  server.registerTool(
    'list_projects',
    {
      description: 'Projects you can see, with your permissions in each.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      guarded(async () => {
        const me = await core.whoami();
        return text(me.projects.map((p) => `${p.key} — ${p.name}`).join('\n'), me.projects);
      }),
  );

  server.registerTool(
    'search_tests',
    {
      description:
        'Search test cases with TQL, e.g. `priority = P0 AND label IN (smoke) AND text ~ "otp retry"~3 ORDER BY updated DESC`. ' +
        'Fields: key, title, text, module, priority, status, label, owner, lastResult, automation, updated, created.',
      inputSchema: {
        project,
        tql: z.string().max(4000),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: key, tql, limit }) =>
      guarded(async () => {
        const p = await core.project(key);
        const res = await core.call<SearchResult>('POST', `/projects/${p.id}/search`, { tql, limit });
        const lines = res.items.map(
          (c) => `${c.key} [${c.priority} · ${c.status} · last ${c.lastResult}] ${c.title} — ${c.modulePath}`,
        );
        return text(`${res.total}${res.totalCapped ? '+' : ''} matches in ${p.key}:\n${lines.join('\n')}`);
      }),
  );

  server.registerTool(
    'get_test_case',
    {
      description: 'One test case with its steps, links and recent results.',
      inputSchema: { project, key: z.string().regex(/^TC-\d+$/i) },
      annotations: { readOnlyHint: true },
    },
    async ({ project: key, key: caseKey }) =>
      guarded(async () => {
        const p = await core.project(key);
        const c = await core.get<CaseDetail>(`/projects/${p.id}/cases/${caseKey.toUpperCase()}`);
        const steps = c.version.steps.map((s, i) => `${i + 1}. ${s.action} → ${s.expected}`).join('\n');
        return text(
          `${c.key} ${c.title}\n${c.priority} · ${c.status} · ${c.modulePath}\n${c.preconditions ? `Preconditions: ${c.preconditions}\n` : ''}${steps}`,
        );
      }),
  );

  server.registerTool(
    'create_test_cases',
    {
      description:
        'Create test cases (as drafts unless status is given) in a module, named by path like "UPI / Collect".',
      inputSchema: {
        project,
        module: z.string().max(300),
        cases: z
          .array(
            z.object({
              title: z.string().min(3).max(300),
              priority: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
              preconditions: z.string().max(5000).default(''),
              steps: z
                .array(z.object({ action: z.string().min(1), expected: z.string().default('') }))
                .max(50)
                .default([]),
              labels: z.array(z.string()).max(20).default([]),
            }),
          )
          .min(1)
          .max(50),
        status: z.enum(['draft', 'in_review', 'ready']).default('draft'),
      },
    },
    async ({ project: key, module, cases, status }) =>
      guarded(async () => {
        const p = await core.project(key);
        const m = findModule(await core.get<ModuleNode[]>(`/projects/${p.id}/modules`), module);
        if (!m) throw new CoreError(404, `No module "${module}" in ${p.key}.`);
        const created: string[] = [];
        for (const c of cases) {
          const res = await core.call<CaseDetail>('POST', `/projects/${p.id}/cases`, {
            ...c,
            moduleId: m.id,
            status,
          });
          created.push(`${res.key} ${res.title}`);
        }
        return text(`Created ${created.length} cases in ${m.name}:\n${created.join('\n')}`);
      }),
  );

  server.registerTool(
    'create_run',
    {
      description: 'Create a test run from the cases a TQL query matches (up to 5,000).',
      inputSchema: {
        project,
        name: z.string().min(3).max(200),
        tql: z.string().max(4000),
        type: z.enum(['smoke', 'regression', 'custom', 'exploratory']).default('custom'),
        environment: z.string().max(60).default('Staging-IN'),
        build: z.string().max(60),
        configs: z.array(z.string().max(80)).min(1).max(8).default(['Chrome 128 · Win 11']),
      },
    },
    async ({ project: key, name, tql, type, environment, build, configs }) =>
      guarded(async () => {
        const p = await core.project(key);
        const { keys } = await core.call<{ keys: string[] }>('POST', `/projects/${p.id}/search/keys`, {
          tql,
        });
        if (!keys.length) throw new CoreError(400, 'The query matches no cases.');
        const run = await core.call<RunSummary>('POST', `/projects/${p.id}/runs`, {
          name,
          type,
          environment,
          build,
          configs,
          filter: { keys: keys.slice(0, 5000) },
        });
        return text(`Created ${run.key} "${run.name}" with ${run.counts.total} items on build ${run.build}.`);
      }),
  );

  server.registerTool(
    'get_run_status',
    {
      description: 'Progress of a run: counts by result, and the failed and blocked items.',
      inputSchema: { project, run: z.string().regex(/^RUN-\d+$/i) },
      annotations: { readOnlyHint: true },
    },
    async ({ project: key, run: runKey }) =>
      guarded(async () => {
        const p = await core.project(key);
        const run = await findRun(core, p.id, runKey);
        const items = await core.get<RunItemRow[]>(`/projects/${p.id}/runs/${run.id}/items`);
        const bad = items.filter((i) => i.status === 'failed' || i.status === 'blocked');
        const c = run.counts;
        return text(
          `${run.key} ${run.name} (${run.status}, build ${run.build})\n` +
            `passed ${c.passed} · failed ${c.failed} · blocked ${c.blocked} · skipped ${c.skipped} · untested ${c.untested} of ${c.total}\n` +
            bad
              .slice(0, 50)
              .map((i) => `${i.status.toUpperCase()} ${i.caseKey} ${i.title} [${i.config}]`)
              .join('\n'),
        );
      }),
  );

  server.registerTool(
    'log_bug',
    {
      description:
        'Log a Jira bug for a failed item in a run (the case and its failing step are attached automatically).',
      inputSchema: {
        project,
        run: z.string().regex(/^RUN-\d+$/i),
        case: z.string().regex(/^TC-\d+$/i),
        summary: z.string().min(5).max(250),
        severity: z.enum(['Blocker', 'Critical', 'Major', 'Minor', 'Trivial']).default('Major'),
      },
    },
    async ({ project: key, run: runKey, case: caseKey, summary, severity }) =>
      guarded(async () => {
        const p = await core.project(key);
        const run = await findRun(core, p.id, runKey);
        const items = await core.get<RunItemRow[]>(`/projects/${p.id}/runs/${run.id}/items`);
        const item =
          items.find((i) => i.caseKey.toLowerCase() === caseKey.toLowerCase() && i.status === 'failed') ??
          items.find((i) => i.caseKey.toLowerCase() === caseKey.toLowerCase());
        if (!item) throw new CoreError(404, `${caseKey} is not in ${run.key}.`);
        const bug = await core.call<{ jiraKey: string; jiraUrl: string }>(
          'POST',
          `/projects/${p.id}/defects`,
          {
            runId: run.id,
            itemId: item.id,
            summary,
            severity,
          },
        );
        return text(`Logged ${bug.jiraKey}: ${bug.jiraUrl}`);
      }),
  );

  server.registerTool(
    'get_prd',
    {
      description:
        'A PRD with its requirements and how well cases cover them. Without a title, lists the PRDs.',
      inputSchema: { project, title: z.string().max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ project: key, title }) =>
      guarded(async () => {
        const p = await core.project(key);
        const docs = await core.get<DocumentSummary[]>(`/projects/${p.id}/documents`);
        if (!title)
          return text(
            docs
              .map(
                (d) =>
                  `${d.title} v${d.version} · ${d.covered}/${d.requirements} covered · ${d.needsReview} need review`,
              )
              .join('\n') || 'No PRDs yet.',
          );
        const doc = docs.find((d) => d.title.toLowerCase().includes(title.toLowerCase()));
        if (!doc) throw new CoreError(404, `No PRD matching "${title}".`);
        const detail = await core.get<DocumentDetail>(`/projects/${p.id}/documents/${doc.id}`);
        const reqs = detail.requirements.map(
          (r) =>
            `${r.ref} [${r.coverage}, ${r.caseCount} cases${r.change !== 'unchanged' ? `, ${r.change} in v${r.changedIn}` : ''}] ${r.text}`,
        );
        return text(`${detail.title} v${detail.currentVersion}\n${reqs.join('\n')}`);
      }),
  );

  server.registerTool(
    'get_traceability',
    {
      description:
        'Requirement-to-case traceability for a PRD: coverage, pass rate per environment and open bugs.',
      inputSchema: { project, title: z.string().max(200) },
      annotations: { readOnlyHint: true },
    },
    async ({ project: key, title }) =>
      guarded(async () => {
        const p = await core.project(key);
        const docs = await core.get<DocumentSummary[]>(`/projects/${p.id}/documents`);
        const doc = docs.find((d) => d.title.toLowerCase().includes(title.toLowerCase()));
        if (!doc) throw new CoreError(404, `No PRD matching "${title}".`);
        const t = await core.get<Traceability>(`/projects/${p.id}/documents/${doc.id}/traceability`);
        const rows = t.rows.map((r) => {
          const pass = t.environments
            .map((e) => `${e} ${r.passRate[e] ?? '—'}${r.passRate[e] === null ? '' : '%'}`)
            .join(', ');
          return `${r.ref} ${r.coverage} · ${r.caseCount} cases · ${pass}${r.openBugs.length ? ` · bugs ${r.openBugs.join(', ')}` : ''}`;
        });
        return text(`${doc.title} traceability:\n${rows.join('\n')}`);
      }),
  );

  return server;
}

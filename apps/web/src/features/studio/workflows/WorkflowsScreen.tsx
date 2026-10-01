'use client';

import type { SiteGraph, StudioComponent, Workflow } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago } from '@/lib/format';
import { SitePane, type SiteGuide } from '../ide/SitePane';
import { ChecksEditor, useWorkflowPlan } from './checks';
import { RecordWizard } from './RecordWizard';
import { Scenarios } from './Scenarios';
import { TestPlan } from './TestPlan';
import w from './workflows.module.css';

type View = 'overview' | 'plan' | 'scenarios' | 'tests';
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'plan', label: 'What to test' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'tests', label: 'Tests' },
];

const rulesText = (r: Workflow['fields'][number]['rules']) =>
  [r.required && 'required', r.minLength > 0 && `min ${r.minLength}`, r.maxLength > 0 && `max ${r.maxLength}`, r.pattern && 'pattern', r.options.length > 0 && `${r.options.length} options`]
    .filter(Boolean)
    .join(', ') || '—';

/**
 * Workflows (testing-studio-plan §3.3): the project's library of recorded journeys. Each is recorded
 * once, after what it needs first, then tested with scenarios agreed for it; journeys of several
 * workflows become test cases (Tests → New journey), and the site map shows how they join up.
 */
export function WorkflowsScreen({ header }: { header: ReactNode }) {
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get('id');
  const creating = params.get('new') === '1';
  const view = (params.get('view') as View) ?? 'overview';
  const go = (q: { id?: string | null; view?: View; creating?: boolean }) => {
    const u = new URLSearchParams({ tab: 'workflows' });
    if (q.creating) u.set('new', '1');
    else if (q.id) u.set('id', q.id);
    if (q.view && q.id) u.set('view', q.view);
    router.replace(`/automation?${u.toString()}`);
  };
  // The browser shows when it is needed (recording, running scenarios) unless the tester says otherwise.
  const [browser, setBrowser] = useState<boolean | null>(null);
  const [justSaved, setJustSaved] = useState<{ id: string; prerequisiteRan: boolean } | null>(null);
  const [autoRun, setAutoRun] = useState(0);
  const needsBrowser = creating || view === 'scenarios';
  const showBrowser = browser ?? needsBrowser;

  return (
    <div className={w.screen}>
      <div className={w.top}>{header}</div>
      <div className={w.shell}>
        <Library selected={creating ? null : selected} onSelect={(id) => go({ id, view: 'overview' })} onNew={() => go({ creating: true })} />
        <SitePane
          onInsert={() => false}
          siteHidden={!showBrowser}
          guide={(g) =>
            creating ? (
              <RecordWizard
                guide={g}
                onCancel={() => go({ id: selected })}
                onSaved={(wf, prerequisiteRan) => {
                  setJustSaved({ id: wf.id, prerequisiteRan });
                  go({ id: wf.id, view: 'plan' });
                }}
              />
            ) : selected ? (
              <WorkflowView
                key={selected}
                id={selected}
                view={view}
                guide={g}
                onView={(v) => go({ id: selected, view: v })}
                browser={showBrowser}
                onBrowser={setBrowser}
                prerequisiteRan={justSaved?.id === selected && justSaved.prerequisiteRan}
                autoRun={autoRun}
                onDeleted={() => go({})}
                onBuilt={() => {
                  setAutoRun((n) => n + 1);
                  setBrowser(null);
                  go({ id: selected, view: 'scenarios' });
                }}
              />
            ) : (
              <div className={w.body}>
                <p className={w.lead}>
                  A workflow is one thing a user does on the site, recorded once: signing in, creating a project, adding a module.
                  Pick one on the left to see what it does and test it, or record a new one. Workflows join into journeys, which
                  become test cases; the Site map shows them all.
                </p>
                <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} onClick={() => go({ creating: true })}>
                  <Icon name="plus" size={11} /> Record a workflow
                </button>
              </div>
            )
          }
        />
      </div>
    </div>
  );
}

function Library({ selected, onSelect, onNew }: { selected: string | null; onSelect(id: string): void; onNew(): void }) {
  const { project } = useSession();
  const workflows = useQuery({ queryKey: ['studio-workflows', project.id], queryFn: () => get<Workflow[]>(`/projects/${project.id}/studio/workflows`) });
  const graph = useQuery({ queryKey: ['site-graph', project.id], queryFn: () => get<SiteGraph>(`/projects/${project.id}/studio/site/graph`) });
  const [q, setQ] = useState('');
  // Grouped by the page each starts on: what a tester sees first when looking for one.
  const groups = useMemo(() => {
    const out = new Map<string, Workflow[]>();
    for (const wf of workflows.data ?? []) {
      if (q && !`${wf.name} ${wf.intent}`.toLowerCase().includes(q.toLowerCase())) continue;
      const from = graph.data?.workflows.find((g) => g.id === wf.id)?.from ?? wf.pages[0]?.path ?? '/';
      out.set(from, [...(out.get(from) ?? []), wf]);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [workflows.data, graph.data, q]);
  return (
    <aside className={w.library} aria-label="Workflows">
      <div className={w.libHead}>
        <input className={`inp f1 ${w.small}`} placeholder="Find a workflow" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a workflow" />
        <button className="btn sm primary" onClick={onNew} title="Record a new workflow"><Icon name="plus" size={11} /> New</button>
      </div>
      <div className={w.libList}>
        {workflows.isLoading && <span className={w.muted}>Loading…</span>}
        {workflows.data?.length === 0 && <span className={w.muted}>No workflows yet. Record the first one.</span>}
        {groups.map(([from, list]) => (
          <div key={from}>
            <div className={w.libGroup}>Starts on {from}</div>
            {list.map((wf) => {
              const g = graph.data?.workflows.find((x) => x.id === wf.id);
              const confirmed = g?.scenarios.filter((s) => s.status === 'confirmed').length ?? 0;
              return (
                <button key={wf.id} className={w.libItem} aria-current={selected === wf.id} onClick={() => onSelect(wf.id)}>
                  <b>{wf.name} <span className={w.muted}>v{wf.version}</span></b>
                  <span className={w.muted}>
                    {g ? `${g.scenarios.length} scenario${g.scenarios.length === 1 ? '' : 's'} (${confirmed} confirmed) · ${g.usedBy.length} test${g.usedBy.length === 1 ? '' : 's'}` : `${wf.fields.length} fields`}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}

function WorkflowView({ id, view, guide, onView, browser, onBrowser, prerequisiteRan, autoRun, onBuilt, onDeleted }: {
  id: string;
  view: View;
  guide: SiteGuide;
  onView(v: View): void;
  browser: boolean;
  onBrowser(on: boolean): void;
  prerequisiteRan: boolean;
  autoRun: number;
  onBuilt(): void;
  onDeleted(): void;
}) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const workflows = useQuery({ queryKey: ['studio-workflows', project.id], queryFn: () => get<Workflow[]>(`/projects/${project.id}/studio/workflows`) });
  const components = useQuery({ queryKey: ['studio-components', project.id], queryFn: () => get<StudioComponent[]>(`/projects/${project.id}/studio/components`) });
  const graph = useQuery({ queryKey: ['site-graph', project.id], queryFn: () => get<SiteGraph>(`/projects/${project.id}/studio/site/graph`) });
  const { plan, update } = useWorkflowPlan(id);
  const workflow = workflows.data?.find((x) => x.id === id);
  const node = graph.data?.workflows.find((x) => x.id === id);
  // Built in this visit: the scenarios run by themselves once the browser is ready.
  const [ranFor] = useState(autoRun);

  if (!workflow || !plan || !components.data) return <div className={w.body}><span className={w.muted}>{workflows.data && !workflow ? 'That workflow is gone.' : 'Loading…'}</span></div>;
  if (!can('run.execute')) return <div className={w.body}><span className={w.muted}>Workflows need permission to run tests in this project.</span></div>;
  const confirmed = plan.scenarios.filter((s) => s.status === 'confirmed').length;
  const remove = async () => {
    const used = node?.usedBy.length ?? 0;
    if (!window.confirm(`Delete “${workflow.name}”?${used ? ` ${used} test${used === 1 ? '' : 's'} using it keep working.` : ''}`)) return;
    try {
      await api('DELETE', `/projects/${project.id}/studio/workflows/${workflow.id}`);
      for (const key of [['studio-workflows', project.id], ['site-graph', project.id], ['studio-components', project.id]]) await queryClient.invalidateQueries({ queryKey: key });
      notify(`Deleted “${workflow.name}”`);
      onDeleted();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete the workflow', 'bad');
    }
  };

  return (
    <div className={w.guide}>
      <div className={w.panelHead}>
        <b className="f1" style={{ fontSize: 14 }}>{workflow.name} <span className={w.muted}>v{workflow.version}</span></b>
        <button className="btn sm" onClick={() => onBrowser(!browser)} title="The Test Browser keeps running while hidden">
          <Icon name="globe" size={11} /> {browser ? 'Hide browser' : 'Show browser'}
        </button>
        <Link className="btn sm" href={`/automation?tab=sitemap&focus=${encodeURIComponent(`w:${workflow.id}`)}`}><Icon name="tree" size={11} /> Site map</Link>
        <Link className="btn sm" href={`/automation?tab=tests&journey=${workflow.id}`}><Icon name="arrowRight" size={11} /> Use in a journey</Link>
        <button className="ib sm" aria-label="Delete this workflow" title="Delete this workflow" onClick={remove}><Icon name="x" size={12} /></button>
      </div>
      <div className={w.panelHead} style={{ paddingTop: 4 }}>
        <span className={w.muted}>{workflow.intent}</span>
      </div>
      <div className={w.tabs} role="tablist">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" className={w.tab} aria-selected={view === v.id} onClick={() => onView(v.id)}>
            {v.label}
            {v.id === 'scenarios' && plan.scenarios.length > 0 && <span className={w.pill} style={{ marginLeft: 6 }}>{confirmed}/{plan.scenarios.length}</span>}
            {v.id === 'tests' && node && node.usedBy.length > 0 && <span className={w.pill} style={{ marginLeft: 6 }}>{node.usedBy.length}</span>}
          </button>
        ))}
      </div>

      {view === 'overview' && (
        <div className={w.body}>
          <section className={w.box}>
            <b>Journey</b>
            <span>
              {workflow.prerequisite ? <>After <b>{workflow.prerequisite.name}</b> · </> : null}
              starts on <code>{node?.from ?? workflow.pages[0]?.path}</code>
              {node?.startAction && <> with “{node.startAction}”</>}, ends on <code>{node?.to ?? workflow.pages.at(-1)?.path}</code>
              {workflow.submitLabel && <> · submits with “{workflow.submitLabel}”</>}
            </span>
            <span className={w.muted}>Recorded on {workflow.baseUrl || 'the site'} · updated {ago(workflow.updatedAt)}</span>
          </section>
          <section className={w.box}>
            <b>Fields</b>
            <table className={w.table}>
              <thead><tr><th>Field</th><th>Kind</th><th>Rules in the page</th><th>Recorded</th></tr></thead>
              <tbody>
                {workflow.fields.map((f) => (
                  <tr key={f.key}><td>{f.label}</td><td>{f.kind}</td><td>{rulesText(f.rules)}</td><td>{f.secret ? '••••' : f.recorded || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className={w.box}>
            <b>APIs it calls <span className={w.muted}>while recorded</span></b>
            {workflow.apis.length ? (
              <table className={w.table}>
                <thead><tr><th>Call</th><th>Status</th><th>After</th></tr></thead>
                <tbody>{workflow.apis.map((a, i) => <tr key={i}><td><code>{a.method} {a.path}</code></td><td>{a.status ?? '–'}</td><td>{a.after}</td></tr>)}</tbody>
              </table>
            ) : (
              <span className={w.muted}>None recorded. Record it again to capture them.</span>
            )}
          </section>
          <section className={w.box}>
            <b>Checked on every success <span className={w.muted}>added to each test made from it</span></b>
            <ChecksEditor checks={plan.checks} onChange={(next) => update({ checks: next })} apis={workflow.apis} storage={plan.scenarios.flatMap((s) => s.seen?.storage ?? [])} />
          </section>
          <section className={w.box}>
            <b>Pages</b>
            {workflow.pages.map((p, i) => (
              <div key={i} className={w.choices}>
                <span><code>{p.path}</code> {p.title && <span className={w.muted}>· {p.title}</span>}</span>
                {p.headings.length > 0 && <span className={w.muted}>Headings: {p.headings.join(', ')}</span>}
                {p.messages.map((m, j) => <span key={j} className={w.muted}>{m.kind} after “{m.after}”: {m.text}</span>)}
              </div>
            ))}
          </section>
        </div>
      )}

      {view === 'plan' && (
        <TestPlan
          workflow={workflow}
          saved={plan}
          onBuilt={(p, answer) => {
            update({ intent: p.intent, validations: p.validations, messages: [{ role: 'tester', text: p.intent }, { role: 'assistant', text: answer.reply }], scenarios: answer.scenarios });
            onBuilt();
          }}
        />
      )}

      {(view === 'scenarios' || view === 'tests') && (
        <>
          <Scenarios
            key={`${workflow.id}@${workflow.version}#${autoRun}`}
            workflow={workflow}
            components={components.data}
            guide={guide}
            stage={view}
            onStage={(s) => onView(s)}
            plan={plan}
            update={update}
            autoRun={autoRun > ranFor}
            prerequisiteRan={prerequisiteRan}
            onPlan={() => onView('plan')}
          />
          {view === 'tests' && node && node.usedBy.length > 0 && (
            <div className={w.body} style={{ flex: 'none', paddingTop: 0 }}>
              <b>Tests that use it</b>
              {node.usedBy.map((u) => (
                <Link key={u.testId} className={w.row} href={`/automation?tab=tests&id=${u.testId}`}>
                  <b>{u.key}</b> {u.title} {u.caseId && <span className={w.pill}>test case</span>}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

'use client';

import type { CaseRow, JourneyResult, ModuleNode, Page, SiteGraph, Workflow, WorkflowPlan } from '@tb/contracts';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { describeCheck } from '../workflows/checks';
import j from './journeys.module.css';

interface Part {
  workflowId: string;
  scenarioIds: string[];
}

/**
 * A journey: workflows in the order a user goes through them, which is what a test case automates.
 * Each workflow but the last runs one scenario that succeeds, so the next starts where it left off;
 * the last runs as many as picked, a data row each. The tests are linked to a test case.
 */
export function JourneyBuilder({ start, onDone }: { start: string | null; onDone(testId: string): void }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const workflows = useQuery({ queryKey: ['studio-workflows', project.id], queryFn: () => get<Workflow[]>(`/projects/${project.id}/studio/workflows`) });
  const graph = useQuery({ queryKey: ['site-graph', project.id], queryFn: () => get<SiteGraph>(`/projects/${project.id}/studio/site/graph`) });
  const modules = useQuery({ queryKey: ['modules', project.id], queryFn: () => get<ModuleNode[]>(`/projects/${project.id}/modules`) });
  const [title, setTitle] = useState('');
  // The title follows the workflows picked until the tester writes their own.
  const [ownTitle, setOwnTitle] = useState(false);
  const [parts, setParts] = useState<Part[]>(start ? [{ workflowId: start, scenarioIds: [] }] : []);
  const [link, setLink] = useState<'none' | 'existing' | 'new'>('new');
  const [caseQuery, setCaseQuery] = useState('');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [moduleId, setModuleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<JourneyResult | null>(null);

  const plans = useQueries({
    queries: parts.map((p) => ({
      queryKey: ['workflow-plan', project.id, p.workflowId],
      queryFn: () => get<WorkflowPlan>(`/projects/${project.id}/studio/workflows/${p.workflowId}/plan`),
    })),
  });
  const cases = useQuery({
    queryKey: ['cases-pick', project.id, caseQuery],
    queryFn: () => get<Page<CaseRow>>(`/projects/${project.id}/cases?limit=20${caseQuery ? `&q=${encodeURIComponent(caseQuery)}` : ''}`),
    enabled: link === 'existing',
  });
  useEffect(() => {
    if (!moduleId && modules.data?.[0]) setModuleId(modules.data[0].id);
  }, [modules.data]);

  const byId = (id: string) => workflows.data?.find((w) => w.id === id);
  const node = (id: string) => graph.data?.workflows.find((w) => w.id === id);
  const planOf = (i: number) => plans[i]?.data;
  // A workflow that is not last goes on to the next, so only a scenario that succeeds fits; confirmed first.
  const choices = (i: number) => {
    const all = planOf(i)?.scenarios ?? [];
    const fit = i < parts.length - 1 ? all.filter((s) => s.expect.outcome === 'success') : all;
    return [...fit].sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed'));
  };
  // Scenarios picked for a part are kept valid as parts are added and removed.
  useEffect(() => {
    setParts((list) =>
      list.map((p, i) => {
        const fit = choices(i);
        if (!fit.length) return p;
        const kept = p.scenarioIds.filter((id) => fit.some((s) => s.id === id));
        if (i < list.length - 1) return { ...p, scenarioIds: [kept[0] ?? fit[0]!.id] };
        return { ...p, scenarioIds: kept.length ? kept : fit.filter((s) => s.status === 'confirmed').map((s) => s.id).slice(0, 30) };
      }),
    );
  }, [parts.length, plans.map((p) => p.dataUpdatedAt).join()]);
  useEffect(() => {
    if (!ownTitle && parts.length) setTitle(parts.map((p) => byId(p.workflowId)?.name).filter(Boolean).join(', then '));
  }, [parts.map((p) => p.workflowId).join(), workflows.data]);

  // What can come next: workflows that start on the page the last one ends on.
  const last = parts.at(-1);
  const nexts = last && graph.data ? graph.data.workflows.filter((w) => w.kind === 'workflow' && w.from === node(last.workflowId)?.to && w.id !== last.workflowId) : [];

  const ready = title.trim().length >= 3 && parts.length > 0 && parts.every((p) => p.scenarioIds.length > 0) && (link !== 'existing' || !!caseId) && (link !== 'new' || !!moduleId);
  const make = async () => {
    setBusy(true);
    try {
      const out = await api<JourneyResult>('POST', `/projects/${project.id}/studio/journeys`, {
        title: title.trim(),
        parts,
        caseId: link === 'existing' ? caseId : null,
        createCase: link === 'new' ? { moduleId } : null,
      });
      setResult(out);
      for (const key of [['studio-tests', project.id], ['data-sets', project.id], ['site-graph', project.id]]) await queryClient.invalidateQueries({ queryKey: key });
      notify(`${out.tests.length} test${out.tests.length === 1 ? '' : 's'} made${out.caseKey ? `, automating ${out.caseKey}` : ''}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not make the journey', 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (!can('case.write')) return <div className="empty t3" style={{ flex: 1 }}>Journeys make tests and test cases, which needs permission to write cases.</div>;

  return (
    <div className={j.wrap}>
      <div className={j.head}>
        <h2>New journey</h2>
        <span className="t3">Workflows in the order a user goes through them. It becomes a test case, and tests that automate it.</span>
      </div>
      <label className={j.field}>
        <span>Title</span>
        <input className="inp" value={title} onChange={(e) => { setTitle(e.target.value); setOwnTitle(true); }} placeholder="Create a project, then add a module" />
      </label>

      <ol className={j.parts}>
        {parts.map((p, i) => {
          const wf = byId(p.workflowId);
          const isLast = i === parts.length - 1;
          const list = choices(i);
          return (
            <li key={`${p.workflowId}-${i}`} className={j.part}>
              <div className={j.partHead}>
                <span className={j.no}>{i + 1}</span>
                <select className="inp f1" style={{ height: 28 }} value={p.workflowId} aria-label={`Workflow ${i + 1}`} onChange={(e) => setParts(parts.map((x, k) => (k === i ? { workflowId: e.target.value, scenarioIds: [] } : x)))}>
                  {workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <button className="ib sm" aria-label="Remove" onClick={() => setParts(parts.filter((_, k) => k !== i))}><Icon name="x" size={11} /></button>
              </div>
              {wf && <span className="t3">{wf.intent}{node(wf.id) && <> · {node(wf.id)!.from} → {node(wf.id)!.to}</>}</span>}
              <div className={j.scenarios}>
                <span className="t3">{isLast ? 'Scenarios to run (a data row each)' : 'Runs this scenario, then goes on'}</span>
                {plans[i]?.isLoading && <span className="t3">Loading…</span>}
                {!plans[i]?.isLoading && !list.length && (
                  <span className={j.warn}>
                    No {isLast ? '' : 'successful '}scenarios yet. <Link href={`/automation?tab=workflows&id=${p.workflowId}&view=plan`}>Agree some for this workflow</Link>.
                  </span>
                )}
                {list.map((s) => (
                  <label key={s.id} className={j.scenario}>
                    <input
                      type={isLast ? 'checkbox' : 'radio'}
                      name={`part-${i}`}
                      checked={p.scenarioIds.includes(s.id)}
                      onChange={(e) =>
                        setParts(parts.map((x, k) => (k !== i ? x : isLast ? { ...x, scenarioIds: e.target.checked ? [...x.scenarioIds, s.id] : x.scenarioIds.filter((id) => id !== s.id) } : { ...x, scenarioIds: [s.id] })))
                      }
                    />
                    <span className={`${j.outcome} ${s.expect.outcome === 'success' ? j.ok : j.bad}`}>{s.expect.outcome === 'success' ? '+' : '−'}</span>
                    <span className="f1">{s.title}</span>
                    <span className="t3">{[s.expect.message, ...s.expect.checks.map(describeCheck)].filter(Boolean).join(' · ')}</span>
                    {s.status !== 'confirmed' && <span className={j.warn}>not confirmed</span>}
                  </label>
                ))}
              </div>
            </li>
          );
        })}
      </ol>

      <div className={j.add}>
        {nexts.map((w) => (
          <button key={w.id} className="btn sm" onClick={() => setParts([...parts, { workflowId: w.id, scenarioIds: [] }])} title={`Starts on ${w.from}, where the last one ends`}>
            <Icon name="plus" size={10} /> {w.name} <span className="t3">next</span>
          </button>
        ))}
        <select className="inp" style={{ height: 28, width: 'auto' }} value="" aria-label="Add a workflow" onChange={(e) => e.target.value && setParts([...parts, { workflowId: e.target.value, scenarioIds: [] }])}>
          <option value="">{parts.length ? 'Add another workflow…' : 'Start with a workflow…'}</option>
          {workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      <fieldset className={j.case}>
        <legend>Test case</legend>
        <label className="row" style={{ gap: 6 }}><input type="radio" checked={link === 'new'} onChange={() => setLink('new')} /> Create one in</label>
        {link === 'new' && (
          <select className="inp" style={{ height: 28 }} value={moduleId} onChange={(e) => setModuleId(e.target.value)} aria-label="Module">
            {modules.data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <label className="row" style={{ gap: 6 }}><input type="radio" checked={link === 'existing'} onChange={() => setLink('existing')} /> Automate an existing one</label>
        {link === 'existing' && (
          <div className={j.caseSearch}>
            <input className="inp" style={{ height: 28 }} placeholder="Find a test case" value={caseQuery} onChange={(e) => setCaseQuery(e.target.value)} />
            {cases.data?.items.map((c) => (
              <label key={c.id} className="row" style={{ gap: 6 }}>
                <input type="radio" name="case" checked={caseId === c.id} onChange={() => setCaseId(c.id)} /> <b className="mono">{c.key}</b> {c.title}
              </label>
            ))}
          </div>
        )}
        <label className="row" style={{ gap: 6 }}><input type="radio" checked={link === 'none'} onChange={() => setLink('none')} /> No test case, tests only</label>
      </fieldset>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={!ready || busy} onClick={make}>{busy ? 'Making…' : 'Make the journey'}</button>
        {!ready && <span className="t3">Give it a title, pick a scenario for each workflow{link === 'existing' ? ' and a test case' : ''}.</span>}
      </div>

      {result && (
        <div className={j.result}>
          <b>Made {result.tests.length} test{result.tests.length === 1 ? '' : 's'}{result.caseKey && <> automating <Link className="mono" href={`/cases/${result.caseKey}`}>{result.caseKey}</Link></>}</b>
          {result.tests.map((t) => (
            <button key={t.id} className={j.testLink} onClick={() => onDone(t.id)}>
              <b className="mono">{t.key}</b> {t.title} <span className="t3">{t.rows} row{t.rows === 1 ? '' : 's'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

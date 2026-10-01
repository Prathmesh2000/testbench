'use client';

import { UNIQUE_TOKEN, type StudioComponent, type WorkflowPlan } from '@tb/contracts';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession } from '@/components/providers';
import { get } from '@/lib/api';
import type { RunDone, SiteGuide } from '../ide/SitePane';
import w from './workflows.module.css';

/** "enterYourEmail" → "Enter your email": a key as words, when no field label is known. */
export function humanise(key: string): string {
  const words = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A field's label where the component knows it (its pages), else its key in words. */
function labelOf(c: StudioComponent, key: string): string {
  return c.meta.pages.flatMap((p) => p.fields).find((f) => f.key === key)?.label ?? humanise(key);
}

const remembered = (id: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(`tb.prereq.${id}`) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
const remember = (id: string, values: Record<string, string>) => {
  try {
    localStorage.setItem(`tb.prereq.${id}`, JSON.stringify(values));
  } catch {
    // Not remembered in this browser; typed again next time.
  }
};

/** The site to run on: the component's own, the workflow's, or the one the Test Browser (or this browser) last had. */
function startSite(component: StudioComponent, fallback: string, pageUrl: string): string {
  const origin = (u: string) => (URL.canParse(u) && /^https?:/.test(u) ? new URL(u).origin : '');
  let last = '';
  try {
    last = localStorage.getItem('tb.ide.siteUrl') ?? '';
  } catch {
    last = '';
  }
  return component.meta.baseUrl || fallback || origin(pageUrl) || origin(last);
}

interface Stage {
  component: StudioComponent;
  /** What follows a workflow's submit (opening what it made), run straight after it. */
  then?: StudioComponent;
}

/**
 * Everything that must run for a prerequisite, oldest first: a workflow that needs another first
 * (adding a module needs a project, which needs signing in) brings that chain with it, and each
 * workflow brings what follows its submit, so the last one leaves the app where the next starts.
 */
export function chainOf(component: StudioComponent, all: StudioComponent[]): Stage[] {
  const out: Stage[] = [];
  const seen = new Set<string>();
  for (let c: StudioComponent | undefined = component; c && !seen.has(c.id) && out.length < 8; c = all.find((x) => x.id === c!.meta.prerequisiteId)) {
    seen.add(c.id);
    const then = c.meta.origin === 'workflow' && c.meta.continuationId ? all.find((x) => x.id === c!.meta.continuationId) : undefined;
    out.unshift({ component: c, then });
  }
  return out;
}

/**
 * Runs what a workflow needs first (signing in, say) in the open Test Browser, so what is recorded
 * or run next starts where it leaves. Values typed here are remembered in this browser for next
 * time; secrets are for this run only and never kept.
 */
export function PrerequisiteRun({
  component,
  components,
  guide,
  values,
  onValues,
  onDone,
  site: fallbackSite = '',
}: {
  component: StudioComponent;
  /** Every component, to find the chain behind `component`. */
  components: StudioComponent[];
  guide: SiteGuide;
  /** Values for `component` itself (the ones the workflow keeps for its tests). */
  values: Record<string, string>;
  onValues(v: Record<string, string>): void;
  onDone?(ok: boolean): void;
  /** Where to run when the prerequisite does not know its own site (one saved before it kept it). */
  site?: string;
}) {
  const { project } = useSession();
  const stages = useMemo(() => chainOf(component, components), [component, components]);
  // A workflow on the way runs a scenario of its own that passes: a fresh {unique} name, not a duplicate.
  const plans = useQueries({
    queries: stages.map((st) => ({
      queryKey: ['workflow-plan', project.id, st.component.id],
      queryFn: () => get<WorkflowPlan>(`/projects/${project.id}/studio/workflows/${st.component.id}/plan`),
      enabled: st.component.meta.origin === 'workflow',
      staleTime: 30_000,
    })),
  });
  const [earlier, setEarlier] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    setEarlier((cur) => {
      const next = { ...cur };
      stages.slice(0, -1).forEach((st, i) => {
        if (next[st.component.id]) return;
        const plan = plans[i]?.data;
        const passing = plan?.scenarios.find((s) => s.status === 'confirmed' && s.expect.outcome === 'success') ?? plan?.scenarios.find((s) => s.expect.outcome === 'success');
        const c = st.component;
        if (c.meta.origin === 'workflow' && !plan) return;
        next[c.id] = { ...c.meta.defaults, ...remembered(c.id), ...passing?.values };
      });
      return next;
    });
  }, [stages, plans.map((p) => p.dataUpdatedAt).join()]);
  // A workflow as the prerequisite itself takes its passing scenario's values the same way, once.
  const ownPlan = plans.at(-1)?.data;
  useEffect(() => {
    if (component.meta.origin !== 'workflow' || !ownPlan) return;
    const passing = ownPlan.scenarios.find((s) => s.status === 'confirmed' && s.expect.outcome === 'success') ?? ownPlan.scenarios.find((s) => s.expect.outcome === 'success');
    if (passing) onValues({ ...values, ...passing.values });
  }, [component.id, !!ownPlan]);
  // The prerequisite's own values start from what was typed here last time, where it has none saved.
  useEffect(() => {
    const before = remembered(component.id);
    const fill = Object.fromEntries(Object.entries(before).filter(([k]) => !values[k]));
    if (Object.keys(fill).length) onValues({ ...values, ...fill });
  }, [component.id]);

  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [site, setSite] = useState(() => startSite(component, fallbackSite, guide.pageUrl));
  const [running, setRunning] = useState<{ stage: number; at: number } | null>(null);
  const [result, setResult] = useState<(RunDone & { stage: number }) | null>(null);
  const secretKeys = [...new Set(stages.flatMap((st) => st.component.meta.secretInputs))];
  const valuesOf = (i: number) => (i === stages.length - 1 ? values : (earlier[stages[i]!.component.id] ?? {}));
  const inputsOf = (st: Stage) => [...new Set([...st.component.inputs, ...(st.then?.inputs ?? [])])].filter((k) => !secretKeys.includes(k));
  const missing = stages.some((st, i) => inputsOf(st).some((k) => !valuesOf(i)[k]?.trim()));

  const run = async () => {
    setResult(null);
    const base = site.replace(/\/+$/, '');
    for (const [i, st] of stages.entries()) {
      setRunning({ stage: i, at: 0 });
      // A {unique} value is made new for this run, as a test run makes it, so the app takes it again.
      const unique = (Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4)).padEnd(8, '0');
      const resolved = Object.fromEntries(Object.entries(valuesOf(i)).map(([k, v]) => [k, v.split(UNIQUE_TOKEN).join(unique)]));
      const steps = [...st.component.steps, ...(st.then?.steps ?? [])];
      const done = await guide.run(steps, resolved, Object.fromEntries(secretKeys.map((k) => [k, secrets[k] ?? ''])), base, (n) => setRunning({ stage: i, at: n + 1 }));
      if (!done.ok || i === stages.length - 1) {
        setRunning(null);
        setResult({ ...done, stage: i });
        if (done.ok) {
          remember(component.id, values);
          for (const s of stages.slice(0, -1)) if (s.component.meta.origin !== 'workflow') remember(s.component.id, earlier[s.component.id] ?? {});
        }
        onDone?.(done.ok);
        return;
      }
    }
  };

  const field = (c: StudioComponent, k: string, value: string, set: (v: string) => void) => (
    <label key={`${c.id}${k}`} className={w.field}>
      <span>{labelOf(c, k)}</span>
      <input className={`inp ${w.small}`} value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  const total = stages.length;
  const now = running && stages[running.stage];

  return (
    <div className={w.box}>
      <b>Run “{component.name}” first</b>
      {total > 1 && (
        <span className={w.muted}>
          Runs {stages.map((st) => `“${st.component.name}”${st.then ? ' and opens what it made' : ''}`).join(', then ')}, so you start where it leaves.
        </span>
      )}
      <label className={w.field}>
        <span>Site <em>the address of the app under test</em></span>
        <input className={`inp ${w.small}`} value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://staging.example.com" />
      </label>
      {stages.map((st, i) => {
        const keys = inputsOf(st);
        if (!keys.length) return null;
        const vals = valuesOf(i);
        const set = (k: string, v: string) =>
          i === stages.length - 1 ? onValues({ ...values, [k]: v }) : setEarlier((cur) => ({ ...cur, [st.component.id]: { ...cur[st.component.id], [k]: v } }));
        return (
          <div key={st.component.id} className={w.choices}>
            {total > 1 && <span className={w.muted}>{st.component.name}</span>}
            <div className={w.grid2}>{keys.map((k) => field(st.component, k, vals[k] ?? '', (v) => set(k, v)))}</div>
          </div>
        );
      })}
      {secretKeys.length > 0 && (
        <div className={w.grid2}>
          {secretKeys.map((k) => (
            <label key={k} className={w.field}>
              <span>{humanise(k)} <em>secret, not saved</em></span>
              <input className={`inp ${w.small}`} type="password" autoComplete="off" value={secrets[k] ?? ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <div className={w.row}>
        {!guide.connected ? (
          <button className="btn sm primary" disabled={!site.trim()} onClick={() => guide.open(site)}><Icon name="globe" size={11} /> Open the site</button>
        ) : (
          <button className="btn sm primary" disabled={!!running || guide.recording !== null || !site.trim()} onClick={run}>
            <Icon name="play" size={11} /> {running ? `Running ${now?.component.name ?? ''} ${running.at}…` : result ? 'Run again' : 'Run it'}
          </button>
        )}
        {missing && !running && <span className={w.warn}>Some values are empty; fill them in so it can sign in.</span>}
        {result && (result.ok ? (
          <span className={w.ok}>Done · now on {result.snapshot?.url ?? 'the page'}</span>
        ) : (
          <span className={w.bad}>
            “{stages[result.stage]?.component.name}” stopped{result.failedAt !== null ? ` at step ${result.failedAt + 1}` : ''}: {result.error}
          </span>
        ))}
      </div>
    </div>
  );
}

'use client';

import type { CaseDetail, CaseVersion, Step } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar, CaseStatusPill, PriorityTag, ResultStatus } from '@/components/status';
import { api, ApiError, get } from '@/lib/api';
import { ago, dateTimeIST } from '@/lib/format';
import { stepsToGherkin, tokenizeGherkinLine } from '@/lib/gherkin';
import { EdgeCases } from '@/features/ai/EdgeCases';
import { ReviewBanner } from './ReviewBanner';
import { StepsEditor } from './StepsEditor';
import s from './detail.module.css';

type Change = { kind: 'same' | 'changed' | 'added' | 'removed'; before?: Step; after?: Step };
type Tab = 'steps' | 'versions' | 'links' | 'history';

/** Full page for one case: content, version history with diffs, links and past results. */
export function CaseDetailScreen({ caseKey }: { caseKey: string }) {
  const { project, can } = useSession();
  const [tab, setTab] = useState<Tab>('steps');
  const detail = useQuery({ queryKey: ['case', project.id, caseKey], queryFn: () => get<CaseDetail>(`/projects/${project.id}/cases/${caseKey}`) });
  const c = detail.data;

  if (detail.error) {
    return <div className="page"><div className="empty" style={{ flex: 1 }}><Icon name="alert" size={20} /><div>{detail.error instanceof ApiError ? detail.error.message : 'Could not load this case.'}</div><Link className="btn" href="/cases">Back to test cases</Link></div></div>;
  }
  if (!c) return <div className="page"><div className="empty t3" style={{ flex: 1 }}>Loading {caseKey}…</div></div>;

  return (
    <div className={s.wrap}>
      <div className={s.main}>
        <div className={s.head}>
          <div className="row t3" style={{ fontSize: 12 }}>
            <Link href="/cases">Test cases</Link><span>/</span><span>{c.modulePath}</span>
          </div>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginTop: 6 }}>
            <span className="mono t2" style={{ paddingTop: 3 }}>{c.key}</span>
            <h1 className="h1 f1" style={{ fontSize: 20, lineHeight: 1.25 }}>{c.title}</h1>
          </div>
          <div className="tabs" role="tablist" style={{ marginTop: 8 }}>
            {(['steps', 'versions', 'links', 'history'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {{ steps: 'Steps', versions: 'Versions', links: 'Links', history: 'History' }[t]}
                <span className="n">{{ steps: c.version.steps.length, versions: c.currentVersion, links: c.dependsOn.length + c.usedBy.length, history: c.recentResults.length }[t]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={s.body}>
          <ReviewBanner c={c} />
          {tab === 'steps' && <StepsTab c={c} canEdit={can('case.write')} />}
          {tab === 'versions' && <VersionsTab c={c} />}
          {tab === 'links' && <LinksTab c={c} canEdit={can('case.write')} />}
          {tab === 'history' && <HistoryTab c={c} />}
        </div>
      </div>

      <aside className={s.side} aria-label="Properties">
        <div className="sec" style={{ marginBottom: 10 }}>Properties</div>
        <dl className={s.dl}>
          <dt>Status</dt><dd><CaseStatusPill status={c.status} /></dd>
          <dt>Priority</dt><dd><PriorityTag priority={c.priority} /></dd>
          <dt>Last result</dt><dd><ResultStatus result={c.lastResult} /></dd>
          <dt>Owner</dt><dd className="row" style={{ gap: 6 }}>{c.owner ? <><Avatar user={c.owner} />{c.owner.name}</> : <span className="t3">Unassigned</span>}</dd>
          <dt>Type</dt><dd>{c.type}</dd>
          <dt>Automation</dt><dd className={`aut-${c.automation}`} style={{ textTransform: 'capitalize' }}>{c.automation}</dd>
          <dt>Estimate</dt><dd>{c.estimateMin ? `${c.estimateMin} min` : <span className="t3">None</span>}</dd>
          <dt>Version</dt><dd className="mono">v{c.currentVersion}</dd>
          <dt>Updated</dt><dd>{ago(c.updatedAt)}</dd>
          <dt>Created</dt><dd>{dateTimeIST(c.createdAt)}</dd>
        </dl>
        {c.labels.length > 0 && (
          <>
            <div className="sec" style={{ margin: '16px 0 8px' }}>Labels</div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{c.labels.map((l) => <span key={l} className="lbl">{l}</span>)}</div>
          </>
        )}
        {can('ai.use') && <EdgeCases key={c.key} c={c} />}
      </aside>
    </div>
  );
}

function StepsTab({ c, canEdit }: { c: CaseDetail; canEdit: boolean }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<'table' | 'gherkin'>(c.version.format === 'gherkin' ? 'gherkin' : 'table');
  const [draft, setDraft] = useState<{ title: string; preconditions: string; steps: Step[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      await api('PATCH', `/projects/${project.id}/cases/${c.key}`, { ...draft, steps: draft.steps.filter((st) => st.action.trim()), baseVersion: c.currentVersion, note: 'Edited steps' });
      await queryClient.invalidateQueries({ queryKey: ['case', project.id, c.key] });
      await queryClient.invalidateQueries({ queryKey: ['cases', project.id] });
      notify(`Saved ${c.key} as version ${c.currentVersion + 1}`);
      setDraft(null);
    } catch (err) {
      // A 409 means someone saved a newer version meanwhile; the message says so and the draft is kept.
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };

  if (draft) {
    return (
      <div className="col" style={{ gap: 14 }}>
        <div className="field"><label htmlFor="ed-title">Title</label><input id="ed-title" className="inp" style={{ height: 32 }} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div className="field"><label htmlFor="ed-pre">Preconditions</label><textarea id="ed-pre" className="inp" rows={2} value={draft.preconditions} onChange={(e) => setDraft({ ...draft, preconditions: e.target.value })} /></div>
        <StepsEditor steps={draft.steps} onChange={(steps) => setDraft({ ...draft, steps })} />
        {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        <div className="row"><button className="btn primary" onClick={save}>Save as version {c.currentVersion + 1}</button><button className="btn" onClick={() => setDraft(null)}>Cancel</button></div>
      </div>
    );
  }

  const gherkin = c.version.gherkin ?? stepsToGherkin(c.title, c.preconditions, c.version.steps);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <div className="seg" role="radiogroup" aria-label="Step format">
          <button role="radio" aria-checked={format === 'table'} className={format === 'table' ? 'on' : ''} onClick={() => setFormat('table')}>Steps</button>
          <button role="radio" aria-checked={format === 'gherkin'} className={format === 'gherkin' ? 'on' : ''} onClick={() => setFormat('gherkin')}>Gherkin</button>
        </div>
        <div className="f1" />
        {canEdit && <button className="btn" onClick={() => setDraft({ title: c.title, preconditions: c.preconditions, steps: c.version.steps })}><Icon name="edit" size={14} />Edit</button>}
      </div>
      {c.preconditions && <div className="banner info"><Icon name="info" /><div><b>Preconditions.</b> {c.preconditions}</div></div>}
      {format === 'table' ? (
        <table className="tbl panel" style={{ overflow: 'hidden' }}>
          <thead><tr><th style={{ width: 36 }}>#</th><th>Action</th><th>Expected result</th><th style={{ width: '22%' }}>Test data</th></tr></thead>
          <tbody>
            {c.version.steps.map((st, i) => (
              <tr key={i}>
                <td className="mono t3" style={{ verticalAlign: 'top', paddingTop: 8 }}>{i + 1}</td>
                <td className={s.wrapCell}>{st.action}</td>
                <td className={`${s.wrapCell} t2`}>{st.expected}</td>
                <td className={`${s.wrapCell} mono t2`}>{st.data}</td>
              </tr>
            ))}
            {c.version.steps.length === 0 && <tr><td colSpan={4} className="t3">No steps yet.</td></tr>}
          </tbody>
        </table>
      ) : (
        <pre className={s.gherkin} aria-label="Gherkin">
          {gherkin.split('\n').map((line, i) => (
            <div key={i}>{tokenizeGherkinLine(line).map((t, j) => <span key={j} className={t.kind === 'kw' ? s.kw : t.kind === 'str' ? s.str : undefined}>{t.text}</span>)}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

function VersionsTab({ c }: { c: CaseDetail }) {
  const { project } = useSession();
  const [selected, setSelected] = useState(c.currentVersion);
  const versions = useQuery({ queryKey: ['versions', project.id, c.key], queryFn: () => get<CaseVersion[]>(`/projects/${project.id}/cases/${c.key}/versions`) });
  const diff = useQuery({
    queryKey: ['version-diff', project.id, c.key, selected],
    queryFn: () => get<{ version: CaseVersion; against: CaseVersion | null; diff: Change[] }>(`/projects/${project.id}/cases/${c.key}/versions/${selected}`),
  });

  return (
    <div className={s.versions}>
      <div className="panel" style={{ overflow: 'hidden', alignSelf: 'flex-start' }}>
        {versions.data?.map((v) => (
          <button key={v.version} className={`${s.ver} ${v.version === selected ? s.verOn : ''}`} onClick={() => setSelected(v.version)}>
            <span className="mono">v{v.version}</span>
            <span className="f1 trunc">{v.note || 'Updated'}</span>
            <span className="t3" style={{ fontSize: 11.5 }}>{v.author?.name ?? '—'} · {ago(v.createdAt)}</span>
          </button>
        ))}
      </div>
      <div className="col" style={{ gap: 8, minWidth: 0 }}>
        {diff.data && (
          <div className="t3" style={{ fontSize: 12 }}>
            {diff.data.against ? <>Changes in <b className="mono">v{diff.data.version.version}</b> compared with <span className="mono">v{diff.data.against.version}</span></> : 'First version'}
          </div>
        )}
        {diff.data && diff.data.against && diff.data.against.title !== diff.data.version.title && (
          <div className={s.titleDiff}><del>{diff.data.against.title}</del><ins>{diff.data.version.title}</ins></div>
        )}
        {diff.data?.diff.map((d, i) => (
          <div key={i} className={`${s.change} ${s[d.kind]}`}>
            <span className={s.mark}>{{ same: '', changed: '~', added: '+', removed: '−' }[d.kind]}</span>
            <div className="f1">
              {d.kind === 'changed' ? (
                <>
                  <div><del>{d.before!.action}</del> {d.before!.action !== d.after!.action && <ins>{d.after!.action}</ins>}</div>
                  <div className="t2" style={{ marginTop: 2 }}>→ {d.before!.expected !== d.after!.expected ? <><del>{d.before!.expected}</del> <ins>{d.after!.expected}</ins></> : d.after!.expected}</div>
                </>
              ) : (
                <>
                  <div>{(d.after ?? d.before)!.action}</div>
                  {(d.after ?? d.before)!.expected && <div className="t2" style={{ marginTop: 2 }}>→ {(d.after ?? d.before)!.expected}</div>}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinksTab({ c, canEdit }: { c: CaseDetail; canEdit: boolean }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const setDeps = async (keys: string[]) => {
    setError(null);
    try {
      await api('PUT', `/projects/${project.id}/cases/${c.key}/dependencies`, { dependsOn: keys });
      await queryClient.invalidateQueries({ queryKey: ['case', project.id, c.key] });
      notify('Prerequisites updated');
      setValue('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update prerequisites');
    }
  };

  return (
    <div className="col" style={{ gap: 18, maxWidth: 760 }}>
      <section>
        <div className="sec" style={{ marginBottom: 8 }}>Depends on</div>
        <div className="t3" style={{ fontSize: 12, marginBottom: 8 }}>In a run, these cases come first. If one fails, this case is blocked automatically.</div>
        {c.dependsOn.map((d) => (
          <div key={d.key} className={s.link}>
            <Link className="mono" href={`/cases/${d.key}`}>{d.key}</Link><span className="trunc f1">{d.title}</span><ResultStatus result={d.lastResult} />
            {canEdit && <button className="ib sm" aria-label={`Remove ${d.key}`} onClick={() => setDeps(c.dependsOn.filter((x) => x.key !== d.key).map((x) => x.key))}><Icon name="x" size={12} /></button>}
          </div>
        ))}
        {c.dependsOn.length === 0 && <div className="t3" style={{ fontSize: 12.5 }}>No prerequisites.</div>}
        {canEdit && (
          <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); const key = value.trim().toUpperCase(); if (key) setDeps([...c.dependsOn.map((d) => d.key), key]); }}>
            <input className="inp" placeholder="TC-10231" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Add prerequisite by key" style={{ width: 160 }} />
            <button className="btn" type="submit"><Icon name="link" size={14} />Add prerequisite</button>
          </form>
        )}
        {error && <div className="banner bad" role="alert" style={{ marginTop: 8 }}><Icon name="alert" />{error}</div>}
      </section>
      <section>
        <div className="sec" style={{ marginBottom: 8 }}>Used by</div>
        {c.usedBy.map((u) => <div key={u.key} className={s.link}><Link className="mono" href={`/cases/${u.key}`}>{u.key}</Link><span className="trunc f1">{u.title}</span></div>)}
        {c.usedBy.length === 0 && <div className="t3" style={{ fontSize: 12.5 }}>No other case depends on this one.</div>}
      </section>
    </div>
  );
}

function HistoryTab({ c }: { c: CaseDetail }) {
  if (c.recentResults.length === 0) return <div className="empty t3" style={{ padding: 40 }}>This case has not been executed yet.</div>;
  return (
    <table className="tbl panel" style={{ overflow: 'hidden' }}>
      <thead><tr><th>Run</th><th>Build</th><th>Configuration</th><th>Result</th><th>When</th></tr></thead>
      <tbody>
        {c.recentResults.map((r, i) => (
          <tr key={i}>
            <td><span className="mono t2">{r.runKey}</span> {r.runName}</td>
            <td className="mono">{r.build}</td>
            <td className="t2">{r.config}</td>
            <td><ResultStatus result={r.status} /></td>
            <td className="t3">{dateTimeIST(r.at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

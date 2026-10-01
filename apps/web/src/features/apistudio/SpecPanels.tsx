'use client';

import { SECURITY_CHECKS } from '@tb/contracts';
import type {
  ApiEnvironment,
  AuthProfileView,
  CoverageView,
  EnrichmentAnswer,
  EnrichmentDraft,
  EnrichmentKind,
  EnrichmentQuestion,
  EnrichmentView,
  GeneratedTest,
  GeneratedView,
  ImpactView,
  MockBody,
  MockHit,
  MockView,
  SecurityCheck,
  SecurityRunView,
  SpecOperation,
  SpecQuality,
  StoredFinding,
} from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import s from './apistudio.module.css';

// The spec's quality report, enrichment questions, generated tests and coverage (plan §9–§11).

const SEVERITY_COLOUR = { error: 'var(--failed)', warning: 'var(--blocked)', info: 'var(--text3)' } as const;

export function QualityPanel({ url, projectId, canEdit }: { url: string; projectId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const q = useQuery({ queryKey: ['apitest', 'quality', url], queryFn: () => get<SpecQuality>(`${url}/quality`) });
  const [showRules, setShowRules] = useState(false);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  if (!q.data) return <div className="t3" style={{ padding: 16 }}>{q.error instanceof ApiError ? q.error.message : 'Checking the spec…'}</div>;
  const d = q.data;
  const toggle = async (rule: string, enabled: boolean) => {
    const reason = enabled ? '' : window.prompt('Why switch this rule off? The reason is shown to everyone in the project.') ?? '';
    if (!enabled && reason.trim().length < 3) return;
    try {
      await api('PUT', `/projects/${projectId}/apitest/quality/rules`, { rule, enabled, reason });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'quality'] });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save', 'bad');
    }
  };
  const shown = d.issues.filter((i) => filter === 'all' || i.severity === filter);
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: d.score >= 80 ? 'var(--passed)' : d.score >= 50 ? 'var(--blocked)' : 'var(--failed)' }}>{d.score}</div>
        <div className="t2" style={{ fontSize: 12.5 }}>
          Quality score of v{d.version}, with enrichment answers applied.<br />
          {d.counts.error} errors · {d.counts.warning} warnings · {d.counts.info} notes across {d.operations} operations and {d.rulesRun} rules.
        </div>
        <div className="f1" />
        <div className="seg" role="radiogroup" aria-label="Show">
          {(['all', 'error', 'warning', 'info'] as const).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : `${f[0]!.toUpperCase()}${f.slice(1)}s`}</button>
          ))}
        </div>
        <button className="btn sm" onClick={() => setShowRules(!showRules)}>{showRules ? 'Issues' : 'Rules'}</button>
      </div>
      {showRules ? (
        <table className="tbl">
          <thead><tr><th>Rule</th><th>Category</th><th>Severity</th><th>Why it matters</th><th>On</th></tr></thead>
          <tbody>
            {d.rules.map((r) => (
              <tr key={r.id}>
                <td><b>{r.title}</b><div className="t3 mono" style={{ fontSize: 11 }}>{r.id}</div></td>
                <td>{r.category}</td>
                <td style={{ color: SEVERITY_COLOUR[r.severity] }}>{r.severity}</td>
                <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{r.why}{r.reason && <div className="t3">Off: {r.reason}</div>}</td>
                <td><input type="checkbox" checked={r.enabled} disabled={!canEdit} aria-label={`Use ${r.title}`} onChange={(e) => toggle(r.id, e.target.checked)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : shown.length ? (
        shown.map((i, n) => (
          <div key={n} className={s.result} style={{ flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <b style={{ color: SEVERITY_COLOUR[i.severity], fontSize: 11.5, width: 60 }}>{i.severity}</b>
              <span>{i.message}</span>
            </div>
            <div className="t2" style={{ paddingLeft: 68, fontSize: 12 }}>{i.fix}</div>
            <div className="t3 mono" style={{ paddingLeft: 68, fontSize: 11 }}>{i.rule} · {i.pointer}</div>
          </div>
        ))
      ) : (
        <div className="t3">Nothing to report{filter !== 'all' ? ` at ${filter} level` : ''}.</div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<EnrichmentKind, string> = {
  security: 'Security',
  error_response: 'Error response',
  required: 'Required fields',
  constraints: 'Limits',
  dependency: 'Dependency',
  example: 'Example',
  side_effect: 'Delete behaviour',
  business_rule: 'Business rule',
};

/** An empty answer of the question's kind, for the form to start from. */
function blankAnswer(q: EnrichmentQuestion): EnrichmentAnswer {
  switch (q.kind) {
    case 'security':
      return { kind: 'security', scheme: 'bearer', roles: [] };
    case 'error_response':
      return { kind: 'error_response', status: '400', description: '', body: '' };
    case 'required':
      return { kind: 'required', fields: [] };
    case 'constraints':
      return { kind: 'constraints', minimum: null, maximum: null, maxLength: null, pattern: '', enum: [] };
    case 'dependency':
      return { kind: 'dependency', confirmed: true };
    case 'example':
      return { kind: 'example', body: '{\n  \n}' };
    case 'side_effect':
      return { kind: 'side_effect', effect: 'hard', field: '', value: '' };
    case 'business_rule':
      return { kind: 'business_rule', text: '' };
  }
}

export function EnrichmentPanel({ url, canEdit }: { url: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const v = useQuery({ queryKey: ['apitest', 'enrichment', url], queryFn: () => get<EnrichmentView>(`${url}/enrichment`) });
  const [show, setShow] = useState<'open' | 'answered' | 'all'>('open');
  const set = (next: EnrichmentView) => {
    queryClient.setQueryData(['apitest', 'enrichment', url], next);
    queryClient.invalidateQueries({ queryKey: ['apitest', 'quality'] });
  };
  if (!v.data) return <div className="t3" style={{ padding: 16 }}>{v.error instanceof ApiError ? v.error.message : 'Reading the spec…'}</div>;
  const d = v.data;
  const list = d.questions.filter((q) => (show === 'all' ? true : show === 'open' ? q.status === 'open' || q.status === 'stale' : q.status === 'answered' || q.status === 'skipped'));
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 30, fontWeight: 700 }}>{d.readiness}%</div>
        <div className="t2" style={{ fontSize: 12.5 }}>
          ready for test generation. {d.counts.open} open · {d.counts.answered} answered · {d.counts.skipped} skipped{d.counts.stale ? ` · ${d.counts.stale} need answering again after a new version` : ''}.<br />
          Answers are kept next to the spec; the upload is never changed. Download the spec with answers to push them back into your source.
        </div>
        <div className="f1" />
        <div className="seg" role="radiogroup" aria-label="Show">
          {(['open', 'answered', 'all'] as const).map((f) => <button key={f} role="radio" aria-checked={show === f} className={show === f ? 'on' : ''} onClick={() => setShow(f)}>{f[0]!.toUpperCase() + f.slice(1)}</button>)}
        </div>
        <a className="btn sm" href={`/api/core${url}/effective`} download="spec-with-answers.json">Download spec with answers</a>
      </div>
      {list.map((q) => <QuestionCard key={q.id} q={q} url={url} canEdit={canEdit} onChange={set} />)}
      {!list.length && <div className="t3">{show === 'open' ? 'No open questions: the spec says what testing needs.' : 'Nothing here yet.'}</div>}
    </div>
  );
}

function QuestionCard({ q, url, canEdit, onChange }: { q: EnrichmentQuestion; url: string; canEdit: boolean; onChange(v: EnrichmentView): void }) {
  const { notify } = useToast();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<EnrichmentAnswer>(q.answer ?? blankAnswer(q));
  const [draftWhy, setDraftWhy] = useState<string | null>(null);
  const [source, setSource] = useState<'user' | 'ai'>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    try {
      onChange(await api<EnrichmentView>('POST', `${url}/enrichment/answer`, { questionId: q.id, answer, source }));
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const status = async (st: 'open' | 'skipped') => {
    try {
      onChange(await api<EnrichmentView>('POST', `${url}/enrichment/status`, { questionId: q.id, status: st }));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save', 'bad');
    }
  };
  const draft = async () => {
    setBusy(true);
    try {
      const d = await api<EnrichmentDraft & { answer: EnrichmentAnswer | null }>('POST', `${url}/enrichment/draft`, { questionId: q.id });
      if (!d.answer || d.ai.status !== 'used') return notify(d.ai.message ?? 'No draft', 'bad');
      setAnswer(d.answer);
      setDraftWhy(d.why);
      setSource('ai');
      setOpen(true);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'The AI model could not be reached', 'bad');
    } finally {
      setBusy(false);
    }
  };
  const edit = (patch: Partial<EnrichmentAnswer>) => {
    setAnswer({ ...answer, ...patch } as EnrichmentAnswer);
    setSource('user');
  };

  return (
    <div className="panel" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="lbl">{KIND_LABEL[q.kind]}</span>
        <span className="mono t2 trunc" style={{ fontSize: 11.5 }}>{q.operation}</span>
        {q.status !== 'open' && <span className="lbl" style={{ color: q.status === 'answered' ? 'var(--passed)' : q.status === 'stale' ? 'var(--blocked)' : undefined }}>{q.status === 'stale' ? 'answer again' : q.status}{q.source === 'ai' ? ' · AI draft accepted' : ''}</span>}
        {q.assignedTo && <span className="t3" style={{ fontSize: 12 }}>asked of {q.assignedTo.name}</span>}
        <div className="f1" />
        {canEdit && !open && q.status !== 'answered' && <button className="btn sm" disabled={busy} onClick={draft} title="A suggestion from the AI model, to check and accept">{busy ? 'Drafting…' : 'Draft with AI'}</button>}
        {canEdit && !open && <button className="btn sm primary" onClick={() => setOpen(true)}>{q.status === 'answered' ? 'Change' : 'Answer'}</button>}
        {canEdit && q.status === 'open' && <button className="btn ghost sm" onClick={() => status('skipped')}>Skip</button>}
        {canEdit && (q.status === 'answered' || q.status === 'skipped') && <button className="btn ghost sm" onClick={() => status('open')}>Reopen</button>}
      </div>
      <div>{q.prompt}</div>
      {q.answeredBy && !open && <div className="t3" style={{ fontSize: 12 }}>Answered by {q.answeredBy}</div>}
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--soft)', paddingTop: 8 }}>
          {draftWhy && <div className={s.notice} style={{ margin: 0 }}><Icon name="sparkle" size={14} /><div>AI draft, not yet saved: {draftWhy}</div></div>}
          <AnswerForm answer={answer} onChange={edit} />
          {error && <div className="err" role="alert">{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary sm" onClick={save}>Save answer</button>
            <button className="btn sm" onClick={() => { setOpen(false); setDraftWhy(null); setAnswer(q.answer ?? blankAnswer(q)); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AnswerForm({ answer, onChange }: { answer: EnrichmentAnswer; onChange(p: Partial<EnrichmentAnswer>): void }) {
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  switch (answer.kind) {
    case 'security':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label className="field"><span className="flab">Scheme (blank for public)</span><input className="inp mono" value={answer.scheme ?? ''} onChange={(e) => onChange({ scheme: e.target.value.trim() || null } as Partial<EnrichmentAnswer>)} /></label>
          <label className="field"><span className="flab">Roles that may call it, comma separated</span><input className="inp" value={answer.roles.join(', ')} onChange={(e) => onChange({ roles: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } as Partial<EnrichmentAnswer>)} /></label>
        </div>
      );
    case 'error_response':
      return (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8 }}>
            <label className="field"><span className="flab">Status</span><input className="inp mono" value={answer.status} onChange={(e) => onChange({ status: e.target.value } as Partial<EnrichmentAnswer>)} /></label>
            <label className="field"><span className="flab">When</span><input className="inp" value={answer.description} placeholder="qty is 0 or missing" onChange={(e) => onChange({ description: e.target.value } as Partial<EnrichmentAnswer>)} /></label>
          </div>
          <label className="field"><span className="flab">Example body (JSON)</span><textarea className={s.code} style={{ minHeight: 70 }} value={answer.body} onChange={(e) => onChange({ body: e.target.value } as Partial<EnrichmentAnswer>)} /></label>
        </>
      );
    case 'required':
      return <label className="field"><span className="flab">Required fields, comma separated</span><input className="inp mono" value={answer.fields.join(', ')} onChange={(e) => onChange({ fields: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } as Partial<EnrichmentAnswer>)} /></label>;
    case 'constraints':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8 }}>
          <label className="field"><span className="flab">Minimum</span><input className="inp" type="number" value={answer.minimum ?? ''} onChange={(e) => onChange({ minimum: num(e.target.value) } as Partial<EnrichmentAnswer>)} /></label>
          <label className="field"><span className="flab">Maximum</span><input className="inp" type="number" value={answer.maximum ?? ''} onChange={(e) => onChange({ maximum: num(e.target.value) } as Partial<EnrichmentAnswer>)} /></label>
          <label className="field"><span className="flab">Max length</span><input className="inp" type="number" value={answer.maxLength ?? ''} onChange={(e) => onChange({ maxLength: num(e.target.value) } as Partial<EnrichmentAnswer>)} /></label>
          <label className="field"><span className="flab">Pattern</span><input className="inp mono" value={answer.pattern} onChange={(e) => onChange({ pattern: e.target.value } as Partial<EnrichmentAnswer>)} /></label>
          <label className="field"><span className="flab">Allowed values</span><input className="inp mono" value={answer.enum.join(', ')} placeholder="a, b, c" onChange={(e) => onChange({ enum: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } as Partial<EnrichmentAnswer>)} /></label>
        </div>
      );
    case 'dependency':
      return (
        <div className="seg" role="radiogroup" aria-label="Is it right">
          <button role="radio" aria-checked={answer.confirmed} className={answer.confirmed ? 'on' : ''} onClick={() => onChange({ confirmed: true } as Partial<EnrichmentAnswer>)}>Yes, it comes from there</button>
          <button role="radio" aria-checked={!answer.confirmed} className={!answer.confirmed ? 'on' : ''} onClick={() => onChange({ confirmed: false } as Partial<EnrichmentAnswer>)}>No</button>
        </div>
      );
    case 'example':
      return <label className="field"><span className="flab">Example body (JSON)</span><textarea className={s.code} style={{ minHeight: 110 }} value={answer.body} onChange={(e) => onChange({ body: e.target.value } as Partial<EnrichmentAnswer>)} /></label>;
    case 'side_effect':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <label className="field"><span className="flab">It</span><select className="inp" value={answer.effect} onChange={(e) => onChange({ effect: e.target.value as 'hard' | 'soft' } as Partial<EnrichmentAnswer>)}><option value="hard">Removes the record</option><option value="soft">Marks it (soft delete)</option></select></label>
          {answer.effect === 'soft' && <label className="field"><span className="flab">Field</span><input className="inp mono" value={answer.field} placeholder="status" onChange={(e) => onChange({ field: e.target.value } as Partial<EnrichmentAnswer>)} /></label>}
          {answer.effect === 'soft' && <label className="field"><span className="flab">Set to</span><input className="inp mono" value={answer.value} placeholder="cancelled" onChange={(e) => onChange({ value: e.target.value } as Partial<EnrichmentAnswer>)} /></label>}
        </div>
      );
    case 'business_rule':
      return <label className="field"><span className="flab">The rule</span><textarea className={s.code} style={{ minHeight: 60, fontFamily: 'inherit' }} value={answer.text} placeholder="total equals the sum of price × qty" onChange={(e) => onChange({ text: e.target.value } as Partial<EnrichmentAnswer>)} /></label>;
  }
}

export function TestsPanel({ url, workspaceId, canEdit }: { url: string; workspaceId: string | null; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const v = useQuery({ queryKey: ['apitest', 'generated', url], queryFn: () => get<GeneratedView>(`${url}/tests`) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<GeneratedTest['status']>('pending');
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const out = new Map<string, GeneratedTest[]>();
    for (const t of v.data?.tests.filter((x) => x.status === show) ?? []) out.set(t.operation, [...(out.get(t.operation) ?? []), t]);
    return [...out.entries()];
  }, [v.data, show]);
  const run = async (fn: () => Promise<GeneratedView>, done: string) => {
    setBusy(true);
    try {
      queryClient.setQueryData(['apitest', 'generated', url], await fn());
      queryClient.invalidateQueries({ queryKey: ['apitest', 'coverage', url] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });
      setPicked(new Set());
      notify(done);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not do that', 'bad');
    } finally {
      setBusy(false);
    }
  };
  const generate = () => run(() => api('POST', `${url}/tests/generate`, {}), 'Tests generated from the spec and its answers');
  const review = (decision: 'accept' | 'reject' | 'pending') =>
    run(() => api('POST', `${url}/tests/review`, { ids: [...picked], decision, workspaceId: workspaceId ?? undefined }), decision === 'accept' ? `Added ${picked.size} as variations of their requests` : decision === 'reject' ? 'Rejected: they will not come back when you regenerate' : 'Moved back to review');
  const d = v.data;
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div className="seg" role="radiogroup" aria-label="Show">
          {(['pending', 'accepted', 'rejected'] as const).map((f) => <button key={f} role="radio" aria-checked={show === f} className={show === f ? 'on' : ''} onClick={() => { setShow(f); setPicked(new Set()); }}>{f === 'pending' ? 'To review' : f[0]!.toUpperCase() + f.slice(1)} <span className="n">{d?.counts[f] ?? 0}</span></button>)}
        </div>
        <span className="t3" style={{ fontSize: 12 }}>Made by rules from the spec and its answers: happy path, required fields, types, limits, allowed values, formats, auth and unknown ids.</span>
        <div className="f1" />
        {canEdit && <button className="btn sm" disabled={busy} onClick={generate}><Icon name="refresh" size={12} />{d?.tests.length ? 'Regenerate' : 'Generate tests'}</button>}
        {canEdit && picked.size > 0 && show !== 'accepted' && <button className="btn sm primary" disabled={busy || !workspaceId} title={workspaceId ? undefined : 'Pick a workspace first'} onClick={() => review('accept')}>Accept {picked.size}</button>}
        {canEdit && picked.size > 0 && show === 'pending' && <button className="btn sm" disabled={busy} onClick={() => review('reject')}>Reject {picked.size}</button>}
        {canEdit && picked.size > 0 && show === 'rejected' && <button className="btn sm" disabled={busy} onClick={() => review('pending')}>Back to review</button>}
      </div>
      {groups.map(([op, tests]) => (
        <div key={op}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0 2px' }}>
            {canEdit && show !== 'accepted' && <input type="checkbox" aria-label={`Pick all for ${op}`} checked={tests.every((t) => picked.has(t.id))} onChange={(e) => setPicked((p) => { const n = new Set(p); for (const t of tests) if (e.target.checked) n.add(t.id); else n.delete(t.id); return n; })} />}
            <b className="mono" style={{ fontSize: 12 }}>{op}</b>
            <span className="t3" style={{ fontSize: 12 }}>{tests.length}</span>
          </div>
          {tests.map((t) => (
            <label key={t.id} className={s.row} style={{ height: 'auto', minHeight: 28, padding: '3px 8px' }}>
              {canEdit && show !== 'accepted' && <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Pick ${t.name}`} />}
              <span className="lbl">{t.kind.replace('_', ' ')}</span>
              <span className="trunc" title={t.why}>{t.name}</span>
              <span className="t3" style={{ marginLeft: 'auto', fontSize: 11.5, whiteSpace: 'nowrap' }}>expects {t.expect.join(' or ')}</span>
            </label>
          ))}
        </div>
      ))}
      {!groups.length && <div className="t3">{d?.tests.length ? 'Nothing in this list.' : 'No tests yet. Generate them; answering the spec questions first gives better ones.'}</div>}
    </div>
  );
}

export function CoveragePanel({ url }: { url: string }) {
  const v = useQuery({ queryKey: ['apitest', 'coverage', url], queryFn: () => get<CoverageView>(`${url}/coverage`) });
  if (!v.data) return <div className="t3" style={{ padding: 16 }}>Counting…</div>;
  const d = v.data;
  const colour = { covered: 'var(--passed-soft)', generated: 'var(--blocked-soft)', missing: 'transparent', undocumented: 'var(--accent-soft)' } as const;
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="t2" style={{ fontSize: 12.5 }}>
        <b style={{ fontSize: 20, color: 'var(--text)' }}>{d.totals.percent}%</b> of documented responses have a test that checks for them: {d.totals.covered} covered, {d.totals.generated} waiting in review, {d.totals.missing} missing.{d.totals.undocumented > 0 && ` Tests also expect ${d.totals.undocumented} status${d.totals.undocumented === 1 ? '' : 'es'} the spec does not document (marked ?): add them to the spec.`}
      </div>
      <div style={{ overflow: 'auto' }}>
        <table className="tbl">
          <thead><tr><th>Operation</th>{d.statuses.map((c) => <th key={c} style={{ textAlign: 'center' }}>{c}</th>)}</tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.operation}>
                <td className="mono" style={{ fontSize: 12 }}>{r.operation}</td>
                {d.statuses.map((c) => (
                  <td key={c} style={{ textAlign: 'center', background: r.cells[c] ? colour[r.cells[c]!] : 'var(--soft)' }} title={r.cells[c] ?? 'not documented'}>
                    {r.cells[c] === 'covered' ? '✓' : r.cells[c] === 'generated' ? '…' : r.cells[c] === 'missing' ? '·' : r.cells[c] === 'undocumented' ? '?' : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="t3" style={{ fontSize: 12 }}>✓ a request or accepted variation checks for it · … a generated test for it waits for review · · nothing checks for it yet · ? tests expect it but the spec does not document it · shaded: not documented for that operation.</div>
    </div>
  );
}

/** Requests and workflows a change in the spec touches, until someone marks them reviewed (plan §8). */
export function ImpactPanel({ url }: { url: string }) {
  const v = useQuery({ queryKey: ['apitest', 'impact', url], queryFn: () => get<ImpactView>(`${url}/impact`) });
  if (!v.data) return <div className="t3" style={{ padding: 16 }}>Looking…</div>;
  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="t2" style={{ fontSize: 12.5 }}>
        {v.data.items.length ? `${v.data.items.length} request${v.data.items.length === 1 ? '' : 's'} and workflows made from an older version of this spec use operations that have changed since. Open each, check it still fits, and mark it reviewed.` : 'Nothing made from this spec is out of date.'}
      </div>
      {v.data.items.map((i) => (
        <div key={`${i.kind}${i.id}`} className="panel" style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="lbl">{i.kind}</span>
            <b>{i.name}</b>
            <span className="t3" style={{ fontSize: 12 }}>in {i.workspaceName}</span>
            {i.operation && <span className="mono t2" style={{ fontSize: 11.5 }}>{i.operation}</span>}
          </div>
          {i.changes.slice(0, 6).map((c, n) => <div key={n} style={{ fontSize: 12.5 }}><span className={c.breaking ? s.fail : 't3'}>{c.breaking ? 'Breaking' : 'Changed'}</span> {c.detail}</div>)}
        </div>
      ))}
    </div>
  );
}

/** A mock of the spec at an unguessable URL: examples first, then schema-built values (plan §14). */
export function MockPanel({ url, operations, canEdit }: { url: string; operations: SpecOperation[]; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const mock = useQuery({ queryKey: ['apitest', 'mock', url], queryFn: () => get<MockView>(`${url}/mock`) });
  const log = useQuery({ queryKey: ['apitest', 'mock-log', url], queryFn: () => get<MockHit[]>(`${url}/mock/log`), refetchInterval: mock.data?.enabled ? 3000 : false });
  const [draft, setDraft] = useState<MockBody | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = mock.data;
  const state: MockBody | null = draft ?? (data ? { enabled: data.enabled, config: data.config, overrides: data.overrides } : null);
  if (!data || !state) return <div className="t3" style={{ padding: 16 }}>{mock.error instanceof ApiError ? mock.error.message : 'Loading…'}</div>;

  const save = async (next: MockBody) => {
    setError(null);
    try {
      const v = await api<MockView>('PUT', `${url}/mock`, next);
      queryClient.setQueryData(['apitest', 'mock', url], v);
      setDraft(null);
      notify(next.enabled ? 'Mock is on' : 'Saved. The mock is off');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const rotate = async () => {
    if (!window.confirm('Give the mock a new URL? The old one stops working at once.')) return;
    queryClient.setQueryData(['apitest', 'mock', url], await api<MockView>('POST', `${url}/mock/rotate`));
  };
  const copy = async () => {
    if (!data.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      notify('Copied');
    } catch {
      notify('Copy failed: select the address and copy it', 'bad');
    }
  };
  const set = (patch: Partial<MockBody>) => setDraft({ ...state, ...patch });
  const ov = (key: string) => state.overrides[key] ?? { status: null, body: '', delayMs: 0 };
  const dirty = draft !== null;

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 940 }}>
      <div className="t2" style={{ fontSize: 12.5 }}>
        Call this address instead of the real API: it answers from the spec’s examples, then from values built from its schemas, with no login. Add <span className="mono">Prefer: code=404</span> (or <span className="mono">X-Mock-Status</span>) to a request to get that documented response. Anyone with the address can use it, so give it a new one if it travels too far.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
          <input type="checkbox" checked={state.enabled} disabled={!canEdit} onChange={(e) => (data.url ? set({ enabled: e.target.checked }) : void save({ ...state, enabled: e.target.checked }))} />
          Mock is {state.enabled ? 'on' : 'off'}
        </label>
        {data.url && <input className="inp mono" style={{ flex: 1 }} readOnly value={data.url} aria-label="Mock address" onFocus={(e) => e.target.select()} />}
        {data.url && <button className="btn sm" onClick={copy}>Copy</button>}
        {data.url && canEdit && <button className="btn ghost sm" onClick={rotate}>New address</button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '170px auto auto', gap: 14, alignItems: 'end' }}>
        <label className="field"><span className="flab">Extra delay (ms)</span><input className="inp" type="number" min={0} max={10000} value={state.config.latencyMs} readOnly={!canEdit} onChange={(e) => set({ config: { ...state.config, latencyMs: Math.min(10000, Math.max(0, Number(e.target.value) || 0)) } })} /></label>
        <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={state.config.validate} disabled={!canEdit} onChange={(e) => set({ config: { ...state.config, validate: e.target.checked } })} /> Refuse requests missing a required input (400 or 422)</label>
        <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={state.config.enforceAuth} disabled={!canEdit} onChange={(e) => set({ config: { ...state.config, enforceAuth: e.target.checked } })} /> Answer 401 to secured operations without a credential</label>
      </div>
      <section>
        <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Fixed answers</h3>
        <div className="t3" style={{ fontSize: 12, marginBottom: 6 }}>Replace what one operation answers: a status, a JSON body, or a delay. Blank keeps the spec’s own.</div>
        {operations.map((o) => {
          const key = `${o.method} ${o.path}`;
          const v = ov(key);
          const set1 = (patch: Partial<typeof v>) => set({ overrides: { ...state.overrides, [key]: { ...v, ...patch } } });
          return (
            <div key={key} style={{ borderBottom: '1px solid var(--soft)', padding: '3px 0' }}>
              <button className={s.row} style={{ height: 28 }} onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                <span className="mono" style={{ fontSize: 12 }}>{key}</span>
                {(v.status !== null || v.body.trim() || v.delayMs > 0) && <span className="lbl">changed</span>}
              </button>
              {open === key && (
                <div style={{ display: 'grid', gridTemplateColumns: '110px 110px 1fr', gap: 8, padding: '4px 8px 8px' }}>
                  <label className="field"><span className="flab">Status</span><input className="inp mono" type="number" placeholder="spec" value={v.status ?? ''} readOnly={!canEdit} onChange={(e) => set1({ status: e.target.value ? Number(e.target.value) : null })} /></label>
                  <label className="field"><span className="flab">Delay (ms)</span><input className="inp" type="number" min={0} value={v.delayMs} readOnly={!canEdit} onChange={(e) => set1({ delayMs: Math.max(0, Number(e.target.value) || 0) })} /></label>
                  <label className="field"><span className="flab">Body (JSON)</span><textarea className={s.code} style={{ minHeight: 56 }} value={v.body} readOnly={!canEdit} onChange={(e) => set1({ body: e.target.value })} /></label>
                </div>
              )}
            </div>
          );
        })}
      </section>
      {error && <div className="err" role="alert">{error}</div>}
      {canEdit && <div><button className="btn primary" disabled={!dirty} onClick={() => save(state)}>{dirty ? 'Save' : 'Saved'}</button></div>}
      {data.url && (
        <section>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Recent requests</h3>
          {log.data?.length ? (
            <table className="tbl">
              <thead><tr><th>When</th><th>Request</th><th>Answered</th><th>Operation</th><th>Took</th></tr></thead>
              <tbody>
                {log.data.slice(0, 20).map((h, i) => (
                  <tr key={i}><td className="t3">{new Date(h.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td className="mono" style={{ fontSize: 12 }}>{h.method} {h.path}</td><td className="mono" style={{ color: h.status < 400 ? 'var(--passed)' : 'var(--failed)' }}>{h.status}</td><td className="mono t2" style={{ fontSize: 11.5 }}>{h.operation ?? 'no match'}</td><td>{h.ms} ms</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="t3" style={{ fontSize: 12.5 }}>{state.enabled ? 'Nothing has called it yet.' : 'Switch the mock on, then call it.'}</div>
          )}
        </section>
      )}
    </div>
  );
}

const CHECK_LABEL: Record<SecurityCheck, [string, string]> = {
  auth: ['Credentials', 'Missing, invalid, tampered and unsigned tokens must be refused'],
  bfla: ['Admin operations', 'A low-privilege account must not reach administrative operations'],
  bola: ['Other accounts’ data', 'A second account must not read the first account’s objects by id'],
  mass_assignment: ['Extra fields', 'Fields like isAdmin or role must not be accepted from the client'],
  injection: ['Injection', 'SQL, script, path and template probes in parameters and body fields'],
  cors: ['CORS', 'A foreign origin must not be trusted with credentials'],
  rate_limit: ['Rate limiting', 'A burst of 25 requests; the API should push back'],
};
const SEV_COLOUR = { high: 'var(--failed)', medium: 'var(--blocked)', low: 'var(--text2)', info: 'var(--text3)' } as const;

/** Attack the spec's API with probes (plan §14): behind the safety gate, with the tester's own accounts. */
export function SecurityPanel({ url, projectId, workspaceId, canEdit, canOverride }: { url: string; projectId: string; workspaceId: string | null; canEdit: boolean; canOverride: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const wbase = workspaceId ? `/projects/${projectId}/apitest/workspaces/${workspaceId}` : null;
  const envs = useQuery({ queryKey: ['apitest', 'envs', workspaceId], queryFn: () => get<ApiEnvironment[]>(`${wbase}/environments`), enabled: !!wbase });
  const profiles = useQuery({ queryKey: ['apitest', 'profiles', workspaceId], queryFn: () => get<AuthProfileView[]>(`${wbase}/profiles`), enabled: !!wbase });
  const findings = useQuery({ queryKey: ['apitest', 'findings', url], queryFn: () => get<StoredFinding[]>(`${url}/security/findings`) });
  const [env, setEnv] = useState('');
  const [checks, setChecks] = useState<Set<SecurityCheck>>(new Set(SECURITY_CHECKS));
  const [other, setOther] = useState('');
  const [low, setLow] = useState('');
  const [values, setValues] = useState('');
  const [override, setOverride] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [show, setShow] = useState<'open' | 'all'>('open');
  const run = useQuery({ queryKey: ['apitest', 'security-run', runId], queryFn: () => get<SecurityRunView>(`${url}/security/runs/${runId}`), enabled: !!runId, refetchInterval: (q) => (q.state.data?.status === 'running' ? 1200 : false) });
  const e = envs.data?.find((x) => x.id === (env || envs.data?.[0]?.id));
  const running = run.data?.status === 'running';
  const parsed = useMemo(() => Object.fromEntries(values.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2 && p[0]!.trim()).map(([k, ...v]) => [k!.trim(), v.join('=').trim()])), [values]);

  const start = async () => {
    setError(null);
    try {
      const r = await api<SecurityRunView>('POST', `${url}/security/runs`, { workspaceId, environmentId: e!.id, values: parsed, checks: [...checks], otherProfileId: other || null, lowProfileId: low || null, productionOverride: override });
      setRunId(r.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the checks');
    }
  };
  const act = async (id: string, what: 'suppress' | 'reopen' | 'bug') => {
    try {
      if (what === 'suppress') {
        const reason = window.prompt('Why is this accepted? It comes back for a second look in 30 days.');
        if (!reason || reason.trim().length < 3) return;
        await api('POST', `${url}/security/findings/${id}/suppress`, { reason: reason.trim(), days: 30 });
      } else if (what === 'reopen') await api('POST', `${url}/security/findings/${id}/reopen`);
      else {
        const d = await api<{ jiraKey: string }>('POST', `${url}/security/findings/${id}/bug`, {});
        notify(`Logged ${d.jiraKey} in Jira`);
      }
      queryClient.invalidateQueries({ queryKey: ['apitest', 'findings', url] });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not do that', 'bad');
    }
  };
  const list = (findings.data ?? []).filter((f) => show === 'all' || f.status === 'open');
  const toggle = (c: SecurityCheck) => setChecks((s) => {
    const n = new Set(s);
    if (n.has(c)) n.delete(c);
    else n.add(c);
    return n;
  });
  if (run.data?.status === 'done' || run.data?.status === 'error') queryClient.invalidateQueries({ queryKey: ['apitest', 'findings', url] });

  return (
    <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 960 }}>
      <div className="t2" style={{ fontSize: 12.5 }}>
        Sends attack probes at the requests made from this spec, as your accounts. They can break things, so they only go to a host you have proved is yours (Safe targets, in workspace settings) and never to production without an admin’s override. Each run is in the audit log.
      </div>
      {canEdit && workspaceId && (
        <section className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <label className="field"><span className="flab">Environment (where the requests go)</span>
              <select className="inp" value={env || envs.data?.[0]?.id || ''} onChange={(ev) => setEnv(ev.target.value)}>
                {envs.data?.map((x) => <option key={x.id} value={x.id}>{x.name}{x.production ? ' (production)' : ''}</option>)}
              </select>
            </label>
            <label className="field"><span className="flab">Second account (for other-accounts’ data)</span>
              <select className="inp" value={other} onChange={(ev) => setOther(ev.target.value)}><option value="">None: skip that check</option>{profiles.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </label>
            <label className="field"><span className="flab">Lowest-role account (for admin operations)</span>
              <select className="inp" value={low} onChange={(ev) => setLow(ev.target.value)}><option value="">None: skip that check</option>{profiles.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {SECURITY_CHECKS.map((c) => (
              <label key={c} style={{ fontSize: 12.5, display: 'flex', gap: 6 }} title={CHECK_LABEL[c][1]}>
                <input type="checkbox" checked={checks.has(c)} onChange={() => toggle(c)} /> <b>{CHECK_LABEL[c][0]}</b> <span className="t3">{CHECK_LABEL[c][1]}</span>
              </label>
            ))}
          </div>
          <label className="field"><span className="flab">Values for what the specs do not say, one per line (name=value): an id that exists, a customer number</span>
            <textarea className={s.code} style={{ minHeight: 50 }} value={values} placeholder="orderId=ord_1001" onChange={(ev) => setValues(ev.target.value)} />
          </label>
          {e?.production && (
            <label style={{ fontSize: 12.5, color: 'var(--failed)' }}>
              <input type="checkbox" checked={override} disabled={!canOverride} onChange={(ev) => setOverride(ev.target.checked)} /> This is a production environment. I understand the probes will hit it
              {!canOverride && <span className="t3"> (only a project admin can allow this)</span>}
            </label>
          )}
          {error && <div className="err" role="alert">{error}</div>}
          <div><button className="btn primary" disabled={running || !checks.size || !e} onClick={start}>{running ? 'Checking…' : 'Run security checks'}</button></div>
        </section>
      )}
      {run.data && (
        <section className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div><b>{running ? <><span className="spin" /> Running against {run.data.host}</> : run.data.status === 'done' ? `Done: ${run.data.findings.length} findings` : run.data.status}</b> <span className="t3" style={{ fontSize: 12 }}>· {run.data.requests} requests sent</span></div>
          {run.data.error && <div className="err">{run.data.error}</div>}
          {run.data.notes.map((n, i) => <div key={i} className="t2" style={{ fontSize: 12.5 }}>{n}</div>)}
        </section>
      )}
      <section>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ fontSize: 13, margin: 0 }}>Findings</h3>
          <div className="seg" role="radiogroup" aria-label="Show"><button role="radio" aria-checked={show === 'open'} className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>Open</button><button role="radio" aria-checked={show === 'all'} className={show === 'all' ? 'on' : ''} onClick={() => setShow('all')}>All</button></div>
        </div>
        {list.map((f) => (
          <div key={f.id} className="panel" style={{ padding: '8px 12px', marginBottom: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <b style={{ color: SEV_COLOUR[f.severity], width: 56 }}>{f.severity}</b>
              <button className="btn ghost sm" style={{ flex: 1, justifyContent: 'flex-start', minWidth: 0 }} onClick={() => setOpen(open === f.id ? null : f.id)} aria-expanded={open === f.id}><span className="trunc">{f.title}</span></button>
              {f.status !== 'open' && <span className="lbl">{f.status}</span>}
              {canEdit && f.status === 'open' && <button className="btn ghost sm" onClick={() => act(f.id, 'bug')}><Icon name="bug" size={12} />Log bug</button>}
              {canEdit && f.status === 'open' && <button className="btn ghost sm" onClick={() => act(f.id, 'suppress')}>Accept</button>}
              {canEdit && f.status !== 'open' && <button className="btn ghost sm" onClick={() => act(f.id, 'reopen')}>Reopen</button>}
            </div>
            <div className="t3" style={{ fontSize: 11.5, paddingLeft: 64 }}>{f.owasp}{f.operation ? ` · ${f.operation}` : ''} · first seen {new Date(f.firstSeen).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}{f.suppressReason ? ` · accepted: ${f.suppressReason}` : ''}</div>
            {open === f.id && (
              <div style={{ paddingLeft: 64, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                <div style={{ fontSize: 12.5 }}>{f.detail}</div>
                <pre className={s.pre} style={{ fontSize: 11.5, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--field)', maxHeight: 180, overflow: 'auto' }}>{f.evidence.request}</pre>
                <pre className={s.pre} style={{ fontSize: 11.5, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--field)', maxHeight: 180, overflow: 'auto' }}>{f.evidence.response}</pre>
              </div>
            )}
          </div>
        ))}
        {!list.length && <div className="t3" style={{ fontSize: 12.5 }}>{findings.data?.length ? 'No open findings.' : 'No findings yet. Run the checks.'}</div>}
      </section>
    </div>
  );
}

'use client';

import type { Coverage, DocumentDetail, DocumentSummary, LinkedCase, RequirementChange, RequirementRow, Traceability, VersionCompare } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { CaseStatusPill } from '@/components/status';
import { api, ApiError, get, qs } from '@/lib/api';
import { ago, fmt } from '@/lib/format';
import { anchorId, diffBlocks, parseBlocks, parseCaseKeys } from './docs-utils';
import { DraftCasesDialog } from './DraftCasesDialog';
import { ImportDialog } from './ImportDialog';
import { DiffBody, DocBody, type ReqContext } from './markdown';
import s from './docs.module.css';

type Tab = 'reader' | 'trace';

const COVERAGE: Record<Coverage, { label: string; cls: string }> = {
  full: { label: 'Full', cls: s.covFull! },
  partial: { label: 'Partial', cls: s.covPart! },
  none: { label: 'None', cls: s.covNone! },
};
const FLAG: Partial<Record<RequirementChange, { label: string; cls: string }>> = {
  changed: { label: 'Changed', cls: s.flChg! },
  added: { label: 'Added', cls: s.flAdd! },
  removed: { label: 'Removed', cls: s.flRem! },
};
const REVIEW_HREF = `/search?q=${encodeURIComponent('status = "Needs review"')}`;

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const plural = (n: number, word: string) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

/** PRDs with their requirements, version diffs, case links and traceability (HLD §5.13). */
export function DocsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { project, can } = useSession();
  const [importing, setImporting] = useState<'new' | 'version' | null>(null);
  const docs = useQuery({ queryKey: ['docs', project.id, 'list'], queryFn: () => get<DocumentSummary[]>(`/projects/${project.id}/documents`) });

  const tab: Tab = params.get('tab') === 'trace' ? 'trace' : 'reader';
  const current = docs.data?.find((d) => d.id === params.get('doc')) ?? docs.data?.[0];
  // Document and tab live in the URL so notification links and reloads land on the same view.
  const go = (doc: string | undefined, t: Tab) => router.replace(`${pathname}${qs({ doc, tab: t === 'trace' ? 'trace' : undefined })}`);

  return (
    <div className={s.layout}>
      <div className={`row ${s.head}`}>
        <h1 className="h1">Docs &amp; PRDs</h1>
        <div className="tabs" role="tablist" style={{ height: 46 }}>
          {(['reader', 'trace'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => go(current?.id, t)}>
              {t === 'reader' ? 'Reader' : 'Traceability matrix'}
            </button>
          ))}
        </div>
        <div className="f1" />
        {can('case.write') && current && <button className="btn sm" onClick={() => setImporting('version')}>Upload new version</button>}
        {can('case.write') && <button className="btn sm" onClick={() => setImporting('new')}><Icon name="plus" size={12} />Import PRD</button>}
      </div>
      <div className={s.body}>
        <aside className={s.plist} aria-label="PRDs">
          <div className="sec" style={{ padding: '4px 10px 8px' }}>PRDs · {project.name}</div>
          {docs.data?.map((d) => (
            <button key={d.id} className={`${s.pi} ${d.id === current?.id ? s.on : ''}`} aria-current={d.id === current?.id} onClick={() => go(d.id, tab)}>
              <span className="row" style={{ gap: 6 }}>
                <span className="trunc" style={{ fontWeight: 500 }}>{d.title}</span>
                <span className={`mono t3 ${s.tiny}`}>v{d.version}</span>
              </span>
              <span className={`t3 ${s.small}`}>{d.version === 1 ? 'Created' : 'Changed'} {ago(d.updatedAt)} · {d.updatedBy}</span>
              <CoverageMeter covered={d.covered} total={d.requirements} />
              {d.needsReview > 0 && <span className="st st-blocked" style={{ fontSize: 11.5, fontWeight: 400 }}>{fmt(d.needsReview)} need review</span>}
            </button>
          ))}
          {docs.isLoading && <div className="t3" style={{ padding: 10 }}>Loading…</div>}
        </aside>
        {docs.data?.length === 0 && (
          <div className="empty f1">
            <Icon name="doc" size={22} />
            <div>No PRDs in {project.name} yet.</div>
            <div className="t3" style={{ fontSize: 12 }}>Import one to link its requirements to cases and see what each new version affects.</div>
            {can('case.write') && <button className="btn primary" onClick={() => setImporting('new')}>Import PRD</button>}
          </div>
        )}
        {current && tab === 'reader' && <ReaderView key={current.id} docId={current.id} />}
        {current && tab === 'trace' && <TraceView doc={current} />}
      </div>
      {importing && (
        <ImportDialog
          target={importing === 'version' && current ? { id: current.id, title: current.title, version: current.version } : undefined}
          onClose={() => setImporting(null)}
          onDone={(id) => { setImporting(null); go(id, tab); }}
        />
      )}
    </div>
  );
}

function CoverageMeter({ covered, total }: { covered: number; total: number }) {
  const pct = total ? Math.round((covered / total) * 100) : 0;
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="meter" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Requirements covered"><i style={{ width: `${pct}%`, background: 'var(--passed)' }} /></span>
      <span className={`t3 num ${s.tiny}`}>{pct}% covered</span>
    </span>
  );
}

/** The document (or its diff against the previous version) beside its requirements list. */
function ReaderView({ docId }: { docId: string }) {
  const { project, can } = useSession();
  const [compare, setCompare] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftFor, setDraftFor] = useState<RequirementRow | null>(null);
  const detail = useQuery({ queryKey: ['docs', project.id, docId, 'detail'], queryFn: () => get<DocumentDetail>(`/projects/${project.id}/documents/${docId}`) });
  const d = detail.data;
  const head = d?.currentVersion ?? 0;
  const cmp = useQuery({
    queryKey: ['docs', project.id, docId, 'compare', head - 1, head],
    queryFn: () => get<VersionCompare>(`/projects/${project.id}/documents/${docId}/compare${qs({ base: head - 1, head })}`),
    enabled: compare && head > 1,
  });

  const byRef = useMemo(() => new Map(d?.requirements.map((r) => [r.ref, r])), [d]);
  // A leading "# Title" is shown as the reader's heading rather than twice.
  const { title, blocks } = useMemo(() => {
    const all = parseBlocks(d?.body ?? '');
    const first = all[0];
    return first?.kind === 'heading' && first.level === 1 ? { title: first.text, blocks: all.slice(1) } : { title: d?.title ?? '', blocks: all };
  }, [d]);
  const diff = useMemo(() => {
    if (!cmp.data) return null;
    const strip = (b: ReturnType<typeof parseBlocks>) => (b[0]?.kind === 'heading' && b[0].level === 1 ? b.slice(1) : b);
    return diffBlocks(strip(parseBlocks(cmp.data.base.body)), strip(parseBlocks(cmp.data.head.body)));
  }, [cmp.data]);

  if (detail.error) return <div className="empty f1"><Icon name="alert" size={22} /><div>{detail.error instanceof ApiError ? detail.error.message : 'Could not load the document'}</div></div>;
  if (!d) return <div className="empty t3 f1">Loading document…</div>;

  const select = (ref: string) => {
    setSelected((cur) => (cur === ref ? null : ref));
    document.getElementById(anchorId(ref))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const ctx: ReqContext = { changeOf: (ref) => byRef.get(ref)?.change, selected, onSelect: select, anchored: compare ? undefined : new Set() };
  const { impact } = d;
  const changes = [impact.changed && `${impact.changed} changed`, impact.added && `${impact.added} added`, impact.removed && `${impact.removed} removed`].filter(Boolean).join(', ');
  const firstUncovered = d.requirements.find((r) => r.change === 'added' && r.caseCount === 0);
  const live = d.requirements.filter((r) => r.change !== 'removed').length;
  const version = d.versions.find((v) => v.version === d.version);
  const baseInfo = d.versions.find((v) => v.version === head - 1);

  return (
    <>
      <div className={`f1 ${s.centre}`}>
        <div style={{ padding: '12px 18px 0', flex: 'none' }}>
          {head > 1 && changes && (
            <div className="banner warn">
              <div className="f1">
                <b>v{head}: {changes}</b>
                {impact.needsReview > 0 && <> → {plural(impact.needsReview, 'case')} need review</>}
                {impact.uncoveredAdded > 0 && <> · <b>{impact.uncoveredAdded} new {impact.uncoveredAdded === 1 ? 'one has' : 'ones have'} no cases</b></>}
              </div>
              {impact.needsReview > 0 && <Link className="btn sm" href={REVIEW_HREF}>Review {fmt(impact.needsReview)} cases</Link>}
              {firstUncovered && can('ai.use') && can('case.write') && <button className="btn sm" onClick={() => setDraftFor(firstUncovered)}>Draft cases for new</button>}
            </div>
          )}
          <div className="row" style={{ padding: '10px 0' }}>
            {head > 1 && (
              <div className="seg" role="radiogroup" aria-label="Version view">
                <button role="radio" aria-checked={!compare} className={compare ? '' : 'on'} onClick={() => setCompare(false)}>v{head}</button>
                <button role="radio" aria-checked={compare} className={compare ? 'on' : ''} onClick={() => setCompare(true)}>Compare v{head - 1} ↔ v{head}</button>
              </div>
            )}
            <div className="f1" />
            <span className="t3" style={{ fontSize: 12 }}>Requirement tags link to the list on the right</span>
          </div>
        </div>
        <div className={s.scroll}>
          <article className={s.reader}>
            <h2>{title}</h2>
            {!compare && (
              <div className={`t3 ${s.meta}`}>v{d.version}{version && ` · ${day(version.createdAt)} by ${version.author}`} · {plural(live, 'requirement')}</div>
            )}
            {!compare && <DocBody blocks={blocks} ctx={ctx} />}
            {compare && cmp.data && diff && (
              <>
                <div className={`t3 ${s.meta}`}>
                  Comparing v{head - 1}{baseInfo && ` (${day(baseInfo.createdAt)})`} ↔ v{head}{version && ` (${day(version.createdAt)})`}
                  {changes && ` · ${changes.replaceAll(', ', ' · ')}`}
                </div>
                <DiffBody diff={diff} ctx={ctx} />
              </>
            )}
            {compare && cmp.isLoading && <div className="t3">Loading comparison…</div>}
            {compare && cmp.error && <div className="err">{cmp.error instanceof ApiError ? cmp.error.message : 'Could not compare the versions'}</div>}
          </article>
        </div>
      </div>
      <aside className={s.aside} aria-label="Requirements">
        <div className={`row ${s.asideHead}`}><span className="sec">Requirements</span><div className="f1" /><span className={`t3 ${s.small}`}>cases</span></div>
        {d.requirements.map((r) => {
          const flag = FLAG[r.change];
          return (
            <div key={r.id}>
              <button className={`${s.rq} ${selected === r.ref ? s.on : ''}`} aria-expanded={selected === r.ref} onClick={() => select(r.ref)}>
                <span className="mono t2">{r.ref}</span>
                <span className="trunc" title={r.text}>{r.title}</span>
                <span className="num t3" style={{ textAlign: 'right' }}>{fmt(r.caseCount)}</span>
                <span />
                <span className="row" style={{ gap: 6 }}>
                  <span className={`${s.cov} ${COVERAGE[r.coverage].cls}`}>{COVERAGE[r.coverage].label}</span>
                  {flag && <span className={`${s.flag} ${flag.cls}`}>{flag.label}</span>}
                </span>
              </button>
              {selected === r.ref && <RequirementCases requirement={r} onDraft={() => setDraftFor(r)} />}
            </div>
          );
        })}
        <div className={`t3 ${s.small}`} style={{ padding: '10px 14px', lineHeight: 1.5 }}>
          Coverage: Full = every linked case is Ready; Partial = some linked cases are not Ready yet; None = no cases.
        </div>
      </aside>
      {draftFor && <DraftCasesDialog requirement={draftFor} onClose={() => setDraftFor(null)} />}
    </>
  );
}

/** Cases linked to one requirement, with link, unlink and AI drafting. */
function RequirementCases({ requirement, onDraft }: { requirement: RequirementRow; onDraft(): void }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [keys, setKeys] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/projects/${project.id}/requirements/${requirement.id}/cases`;
  const cases = useQuery({ queryKey: ['docs', project.id, 'req', requirement.id], queryFn: () => get<LinkedCase[]>(path) });
  const writable = can('case.write') && requirement.change !== 'removed';

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['docs', project.id] });

  const link = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseCaseKeys(keys);
    if (parsed.invalid.length) return setError(`Not a case key: ${parsed.invalid.join(', ')}`);
    if (!parsed.keys.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ linked: number; unknown: string[] }>('POST', path, { caseKeys: parsed.keys });
      await refresh();
      setKeys(r.unknown.join(', '));
      if (r.unknown.length) setError(`No such case: ${r.unknown.join(', ')}`);
      if (r.linked) notify(`${plural(r.linked, 'case')} linked to ${requirement.ref}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link the cases');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (key: string) => {
    try {
      await api('DELETE', `${path}/${key}`);
      await refresh();
      notify(`${key} unlinked from ${requirement.ref}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : `Could not unlink ${key}`, 'bad');
    }
  };

  return (
    <div className={s.detail}>
      <div className="t2" style={{ lineHeight: 1.5 }}>{requirement.text}</div>
      {cases.isLoading && <div className="t3">Loading cases…</div>}
      {cases.data?.length === 0 && <div className="t3">No cases linked yet.</div>}
      {cases.data && cases.data.length > 0 && (
        <div className="col">
          {cases.data.map((c) => (
            <div key={c.key} className={s.lc}>
              <Link className="mono" href={`/cases/${c.key}`}>{c.key}</Link>
              <span className="trunc" title={c.title}>{c.title}</span>
              <CaseStatusPill status={c.status} />
              {writable ? <button className="ib sm" aria-label={`Unlink ${c.key}`} title="Unlink" onClick={() => unlink(c.key)}><Icon name="x" size={12} /></button> : <span />}
            </div>
          ))}
        </div>
      )}
      {writable && (
        <form className="row" style={{ gap: 6 }} onSubmit={link}>
          <input className="inp mono f1" value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="TC-101, TC-102" aria-label={`Case keys to link to ${requirement.ref}`} />
          <button className="btn sm" type="submit" disabled={busy || !keys.trim()}><Icon name="link" size={12} />Link cases</button>
        </form>
      )}
      {error && <div className="err" role="alert">{error}</div>}
      {writable && can('ai.use') && (
        <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={onDraft}>Draft cases with AI</button>
      )}
    </div>
  );
}

/** Requirements × environments: coverage, linked cases, latest pass rate per environment and open bugs. */
function TraceView({ doc }: { doc: DocumentSummary }) {
  const { project } = useSession();
  const trace = useQuery({ queryKey: ['docs', project.id, doc.id, 'trace'], queryFn: () => get<Traceability>(`/projects/${project.id}/documents/${doc.id}/traceability`) });
  const t = trace.data;
  return (
    <div className={s.trace}>
      <section className="panel" style={{ overflow: 'hidden' }}>
        <div className="hdr">
          <h3>{doc.title} v{doc.version} · traceability</h3>
          {t && <span className="cnt">{plural(t.rows.length, 'requirement')}</span>}
        </div>
        {trace.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading…</div>}
        {trace.error && <div className="err" style={{ padding: 12 }}>{trace.error instanceof ApiError ? trace.error.message : 'Could not load traceability'}</div>}
        {t && (
          <div style={{ overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">Requirement</th><th scope="col">Coverage</th><th scope="col">Cases</th>
                  {t.environments.map((env, i) => <th key={env} scope="col">{i === 0 ? `Last-run pass · ${env}` : env}</th>)}
                  <th scope="col">Open bugs</th>
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.requirementId}>
                    <td className="mono" title={r.title}>{r.ref}</td>
                    <td><span className={`${s.cov} ${COVERAGE[r.coverage].cls}`}>{COVERAGE[r.coverage].label}</span></td>
                    <td className="num">{fmt(r.caseCount)}</td>
                    {t.environments.map((env) => {
                      const rate = r.passRate[env];
                      return (
                        <td key={env}>
                          <div className={s.pcell}>
                            <span className="meter"><i style={{ width: `${rate ?? 0}%`, background: 'var(--passed)' }} /></span>
                            <span className="num t2">{rate == null ? '—' : `${rate}%`}</span>
                          </div>
                        </td>
                      );
                    })}
                    <td className="mono acc">{r.openBugs.length ? r.openBugs.join(', ') : <span className="t3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

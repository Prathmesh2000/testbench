'use client';

import type { ApiSpecDetail, ApiSpecSummary, SpecOperation, SpecUploadResult } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, bytes, fmt } from '@/lib/format';
import { CoveragePanel, EnrichmentPanel, ImpactPanel, MockPanel, QualityPanel, SecurityPanel, TestsPanel } from './SpecPanels';
import s from './apistudio.module.css';

// The spec library (plan §8): every OpenAPI/Swagger spec in the project, its versions and what changed.

export function SpecList({ specs, selectedId, onSelect }: { specs: ApiSpecSummary[]; selectedId: string | null; onSelect(id: string): void }) {
  if (!specs.length)
    return (
      <div className="empty t3" style={{ padding: 20, fontSize: 12.5 }}>
        <Icon name="doc" size={20} />
        <div>No specs yet.</div>
        <div>Upload an OpenAPI or Swagger file, or point at its URL, to see every endpoint and make requests from it.</div>
      </div>
    );
  return (
    <>
      {specs.map((sp) => (
        <button key={sp.id} className={`${s.row} ${selectedId === sp.id ? s.on : ''}`} style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => onSelect(sp.id)}>
          <b className="trunc" style={{ maxWidth: '100%' }}>{sp.name}</b>
          <span className="t3" style={{ fontSize: 11.5 }}>
            v{sp.version} · {sp.apiVersion} · {fmt(sp.operationCount)} operations{sp.breakingInLatest ? ` · ` : ''}
            {sp.breakingInLatest > 0 && <span className={s.breaking}>{sp.breakingInLatest} breaking</span>}
          </span>
        </button>
      ))}
    </>
  );
}

/** Upload a new spec (or a new version of one with the same name) from a file, pasted text or a URL. */
export function SpecUploadDialog({ projectId, onClose, onDone }: { projectId: string; onClose(): void; onDone(id: string): void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [mode, setMode] = useState<'file' | 'paste' | 'url'>('file');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const readFile = async (f: File) => {
    if (f.size > 20 * 1024 * 1024) return setError('That file is larger than 20 MB.');
    setFileName(f.name);
    setContent(await f.text());
    if (!name) setName(f.name.replace(/\.(ya?ml|json)$/i, ''));
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<SpecUploadResult>('POST', `/projects/${projectId}/apitest/specs`, mode === 'url' ? { name, url } : { name, content });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'specs', projectId] });
      notify(res.created ? `Saved as version ${res.spec.version}` : 'Nothing changed since the latest version');
      onDone(res.spec.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload the spec');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className={`modal center ${s.form}`} onSubmit={submit} role="dialog" aria-labelledby="spec-up">
        <h3 id="spec-up" style={{ margin: 0, fontSize: 15 }}>Add an API spec</h3>
        <div className="t3" style={{ fontSize: 12.5, marginTop: -6 }}>OpenAPI 3.x or Swagger 2.0, as JSON or YAML. Using an existing name adds a new version and shows what changed.</div>
        <div className="field">
          <label htmlFor="spec-name">Name</label>
          <input id="spec-name" className="inp" value={name} required maxLength={120} placeholder="Orders API" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="seg" role="radiogroup" aria-label="Source">
          {(['file', 'paste', 'url'] as const).map((m) => (
            <button type="button" key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{{ file: 'File', paste: 'Paste', url: 'URL' }[m]}</button>
          ))}
        </div>
        {mode === 'file' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input ref={input} type="file" accept=".json,.yaml,.yml" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
            <button type="button" className="btn" onClick={() => input.current?.click()}><Icon name="paperclip" size={13} />Choose file</button>
            <span className="t2 trunc" style={{ fontSize: 12.5 }}>{fileName ? `${fileName} · ${bytes(content.length)}` : 'No file chosen'}</span>
          </div>
        )}
        {mode === 'paste' && <textarea className={s.code} spellCheck={false} value={content} aria-label="Spec" placeholder={'openapi: 3.0.3\ninfo: …'} onChange={(e) => setContent(e.target.value)} />}
        {mode === 'url' && (
          <div className="field">
            <label htmlFor="spec-url">Spec URL</label>
            <input id="spec-url" className="inp mono" type="url" value={url} placeholder="https://api.example.com/v3/api-docs" onChange={(e) => setUrl(e.target.value)} />
            <span className="t3" style={{ fontSize: 12 }}>Fetched by the Testbench server. It can be fetched again later to make a new version.</span>
          </div>
        )}
        {error && <div className="err" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim() || (mode === 'url' ? !url : !content)}>{busy ? 'Reading…' : 'Add spec'}</button>
        </div>
      </form>
    </>
  );
}

const opKey = (o: SpecOperation) => `${o.method} ${o.path}`;

/** One spec: its operations grouped by tag, the version history with changes, and import into a collection. */
export function SpecView({ projectId, specId, workspaceId, canEdit, canOverride, onImported, onDeleted }: {
  projectId: string;
  canOverride: boolean;
  specId: string;
  workspaceId: string | null;
  canEdit: boolean;
  onImported(collectionId: string): void;
  onDeleted(): void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [version, setVersion] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<'operations' | 'quality' | 'questions' | 'tests' | 'coverage' | 'impact' | 'mock' | 'security'>('operations');
  const [busy, setBusy] = useState(false);
  const url = `/projects/${projectId}/apitest/specs/${specId}`;
  const detail = useQuery({
    queryKey: ['apitest', 'spec', specId, version],
    queryFn: () => get<ApiSpecDetail>(`${url}${version ? `?version=${version}` : ''}`),
  });

  const groups = useMemo(() => {
    const out = new Map<string, SpecOperation[]>();
    const q = filter.trim().toLowerCase();
    for (const o of detail.data?.operations ?? []) {
      if (q && !`${o.method} ${o.path} ${o.summary} ${o.operationId ?? ''}`.toLowerCase().includes(q)) continue;
      const tag = o.tags[0] ?? 'Other';
      out.set(tag, [...(out.get(tag) ?? []), o]);
    }
    return [...out.entries()];
  }, [detail.data, filter]);

  if (detail.error) return <div className="empty t3" style={{ flex: 1 }}>{detail.error instanceof ApiError ? detail.error.message : 'Could not load this spec.'}</div>;
  if (!detail.data) return <div className="empty t3" style={{ flex: 1 }}>Loading…</div>;
  const d = detail.data;
  const shownVersion = version ?? d.version;

  const refetch = async () => {
    setBusy(true);
    try {
      const res = await api<SpecUploadResult>('POST', `${url}/versions`, {});
      notify(res.created ? `Fetched again: version ${res.spec.version}` : 'The spec at that URL has not changed');
      queryClient.invalidateQueries({ queryKey: ['apitest', 'spec', specId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'specs', projectId] });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not fetch the spec', 'bad');
    } finally {
      setBusy(false);
    }
  };
  const importOps = async () => {
    if (!workspaceId) return notify('Pick or create a workspace first', 'bad');
    setBusy(true);
    try {
      const res = await api<{ collectionId: string; created: number }>('POST', `${url}/import`, { workspaceId, version: shownVersion, operations: [...picked] });
      notify(`Made ${res.created} requests. Set {{baseUrl}} in the collection or an environment.`);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });
      onImported(res.collectionId);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not import', 'bad');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the spec "${d.name}" and all its versions? Requests made from it stay.`)) return;
    await api('DELETE', url);
    queryClient.invalidateQueries({ queryKey: ['apitest', 'specs', projectId] });
    onDeleted();
  };
  const toggle = (k: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className={s.specHead}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{d.name}</h2>
          <div className="t2" style={{ fontSize: 12.5, marginTop: 4 }}>
            {d.title} · API version {d.apiVersion} · {d.format === 'swagger2' ? 'Swagger 2.0' : 'OpenAPI 3'} · {fmt(d.operationCount)} operations
            {d.servers[0] && <> · <span className="mono">{d.servers[0]}</span></>}
          </div>
          {d.sourceUrl && <div className="t3 mono trunc" style={{ fontSize: 11.5, marginTop: 2 }}>{d.sourceUrl}</div>}
        </div>
        {canEdit && (
          <>
            {d.sourceUrl && <button className="btn" disabled={busy} onClick={refetch}><Icon name="refresh" size={13} />Fetch again</button>}
            <button className="btn primary" disabled={busy || !workspaceId} onClick={importOps} title="Make a request for each operation in a new collection">
              <Icon name="plus" size={13} />{picked.size ? `Make ${picked.size} requests` : 'Make requests for all'}
            </button>
            <button className="btn ghost danger" onClick={remove} aria-label="Delete spec"><Icon name="x" size={13} /></button>
          </>
        )}
      </div>
      <div className={`tabs ${s.editorTabs}`} role="tablist" aria-label="Spec">
        {([['operations', 'Operations'], ['quality', 'Quality'], ['questions', 'Questions'], ['tests', 'Tests'], ['coverage', 'Coverage'], ['impact', 'Impact'], ['mock', 'Mock'], ['security', 'Security']] as const).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      {tab === 'quality' && <div style={{ overflow: 'auto', flex: 1 }}><QualityPanel url={url} projectId={projectId} canEdit={canEdit} /></div>}
      {tab === 'questions' && <div style={{ overflow: 'auto', flex: 1 }}><EnrichmentPanel url={url} canEdit={canEdit} /></div>}
      {tab === 'tests' && <div style={{ overflow: 'auto', flex: 1 }}><TestsPanel url={url} workspaceId={workspaceId} canEdit={canEdit} /></div>}
      {tab === 'coverage' && <div style={{ overflow: 'auto', flex: 1 }}><CoveragePanel url={url} /></div>}
      {tab === 'impact' && <div style={{ overflow: 'auto', flex: 1 }}><ImpactPanel url={url} /></div>}
      {tab === 'mock' && <div style={{ overflow: 'auto', flex: 1 }}><MockPanel url={url} operations={d.operations} canEdit={canEdit} /></div>}
      {tab === 'security' && <div style={{ overflow: 'auto', flex: 1 }}><SecurityPanel url={url} projectId={projectId} workspaceId={workspaceId} canEdit={canEdit} canOverride={canOverride} /></div>}
      <div className={s.specBody} hidden={tab !== 'operations'} style={tab !== 'operations' ? { display: 'none' } : undefined}>
        <div className={s.ops}>
          <div style={{ padding: '10px 12px 0' }}>
            <input className="inp" style={{ width: '100%' }} value={filter} placeholder="Filter operations" aria-label="Filter operations" onChange={(e) => setFilter(e.target.value)} />
          </div>
          {groups.map(([tag, ops]) => (
            <div key={tag}>
              <div className={s.tag}>{tag}</div>
              {ops.map((o) => (
                <label key={opKey(o)} className={s.row} style={{ height: 'auto', minHeight: 30, padding: '4px 12px' }}>
                  {canEdit && <input type="checkbox" checked={picked.has(opKey(o))} onChange={() => toggle(opKey(o))} aria-label={`Pick ${opKey(o)}`} />}
                  <span className={`${s.method} ${s[`m-${o.method}`]}`}>{o.method}</span>
                  <span className="mono trunc" style={{ textDecoration: o.deprecated ? 'line-through' : undefined }}>{o.path}</span>
                  <span className="t3 trunc" style={{ fontSize: 12 }}>{o.summary}</span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
                    {o.security === null ? null : o.security.length ? <span className="lbl" title={o.security.join(', ')}>auth</span> : <span className="lbl">public</span>}
                    <span className="t3 mono" style={{ fontSize: 11 }}>{o.responses.join(' ')}</span>
                  </span>
                </label>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="t3" style={{ padding: 16 }}>No operations match.</div>}
        </div>
        <aside className={s.versions} aria-label="Versions">
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Versions</h3>
          {d.versions.map((v) => (
            <div key={v.version} className={s.version}>
              <button className={`btn sm ${v.version === shownVersion ? 'primary' : ''}`} onClick={() => setVersion(v.version === d.version ? null : v.version)}>v{v.version}</button>
              <span className="t2" style={{ marginLeft: 8 }}>{v.apiVersion} · {fmt(v.operationCount)} ops · {bytes(v.sizeBytes)}</span>
              <div className="t3" style={{ fontSize: 11.5, marginTop: 4 }}>{ago(v.createdAt)}</div>
              {v.diff ? (
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 12 }}>
                    vs v{v.diff.fromVersion}: +{v.diff.added} −{v.diff.removed} ~{v.diff.changed}
                    {v.diff.breaking > 0 && <span className={s.breaking}> · {v.diff.breaking} breaking</span>}
                  </div>
                  {v.diff.changes.slice(0, 30).map((c, i) => (
                    <div key={i} className={s.change}>
                      <span className={c.breaking ? s.breaking : 't3'}>{c.breaking ? '!' : '·'}</span>
                      <span><span className="mono">{c.method} {c.path}</span> <span className="t2">{c.detail}</span></span>
                    </div>
                  ))}
                  {v.diff.changes.length > 30 && <div className="t3" style={{ fontSize: 12 }}>and {v.diff.changes.length - 30} more</div>}
                  {v.diff.changes.length === 0 && <div className="t3" style={{ fontSize: 12 }}>No operation changes.</div>}
                </div>
              ) : (
                <div className="t3" style={{ fontSize: 12, marginTop: 4 }}>First version.</div>
              )}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

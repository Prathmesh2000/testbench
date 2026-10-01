'use client';

import { HTTP_METHODS, STREAM_PROTOCOLS, type ApiNodeDetail, type ApiRequestDef, type ApiVariation, type HttpMethod, type SendResult, type StreamResult } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { useProfiles } from './AuthPanels';
import { AssertionsEditor, AuthEditor, BodyEditor, ExtractorsEditor, KeyValueTable, ScriptsEditor } from './fields';
import { SnippetDialog } from './Transfer';
import { useLocals } from './locals';
import { overridesFrom, withOverrides } from './model';
import { ResponsePane } from './ResponsePane';
import { PROTOCOL_LABEL, StreamPane, StreamSettingsEditor } from './StreamPane';
import s from './apistudio.module.css';

type Tab = 'params' | 'headers' | 'body' | 'stream' | 'auth' | 'checks' | 'extract' | 'scripts' | 'settings' | 'docs';
const TABS: [Tab, string][] = [
  ['params', 'Params'],
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['stream', 'Stream'],
  ['auth', 'Auth'],
  ['checks', 'Checks'],
  ['extract', 'Extract'],
  ['scripts', 'Scripts'],
  ['settings', 'Settings'],
  ['docs', 'Docs'],
];

interface Props {
  base: string;
  workspaceId: string;
  node: ApiNodeDetail;
  crumbs: string[];
  environmentId: string | null;
  variationId: string | null;
  onVariation(id: string | null): void;
  canEdit: boolean;
}

/**
 * One request: edit it (or one of its variations), send it through the server, and see the response.
 * With a variation picked, the editor shows the request with that variation applied, and saving stores
 * only the fields that differ from the request.
 */
export function RequestEditor({ base, workspaceId, node, crumbs, environmentId, variationId, onVariation, canEdit }: Props) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const locals = useLocals(workspaceId, environmentId);
  const saved = node.request!;
  const variation: ApiVariation | null = node.variations.find((v) => v.id === variationId) ?? null;
  const shown = variation ? withOverrides(saved, variation.overrides) : saved;

  const [draft, setDraft] = useState<ApiRequestDef>(shown);
  const [name, setName] = useState(variation?.name ?? node.name);
  const [tab, setTab] = useState<Tab>('params');
  const [result, setResult] = useState<SendResult | null>(null);
  const [streamResult, setStreamResult] = useState<StreamResult | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const profiles = useProfiles(base, workspaceId);

  useEffect(() => {
    setDraft(shown);
    setName(variation?.name ?? node.name);
    setError(null);
    // Reset only when a different request or variation is opened or saved, not on every refetch.
  }, [node.id, variationId, node.updatedAt, variation?.updatedAt]);

  const protocol = draft.protocol ?? 'http';
  const isStream = protocol !== 'http';
  const dirty = JSON.stringify(draft) !== JSON.stringify(shown) || name !== (variation?.name ?? node.name);
  const patch = (p: Partial<ApiRequestDef>) => setDraft((d) => ({ ...d, ...p }));
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });
    queryClient.invalidateQueries({ queryKey: ['apitest', 'node', workspaceId, node.id] });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (variation) {
        await api('PUT', `${base}/nodes/${node.id}/variations/${variation.id}`, { name, overrides: overridesFrom(saved, draft) });
      } else {
        await api('PATCH', `${base}/nodes/${node.id}`, { name, request: draft });
      }
      refresh();
      notify('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const saveAsVariation = async () => {
    const vname = window.prompt('Name this variation', variation ? `${variation.name} (copy)` : 'New variation');
    if (!vname?.trim()) return;
    try {
      const list = await api<ApiVariation[]>('POST', `${base}/nodes/${node.id}/variations`, { name: vname.trim(), overrides: overridesFrom(saved, draft) });
      refresh();
      onVariation(list[list.length - 1]?.id ?? null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the variation', 'bad');
    }
  };

  const removeVariation = async () => {
    if (!variation || !window.confirm(`Delete the variation "${variation.name}"?`)) return;
    await api('DELETE', `${base}/nodes/${node.id}/variations/${variation.id}`);
    onVariation(null);
    refresh();
  };

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      if (isStream) {
        const res = await api<StreamResult>('POST', `${base}/stream`, { request: draft, nodeId: node.id, environmentId, locals: locals.values });
        setStreamResult(res);
        if (Object.keys(res.extracted).length) locals.update(res.extracted, []);
        return;
      }
      const res = await api<SendResult>('POST', `${base}/send`, { request: draft, nodeId: node.id, environmentId, locals: locals.values });
      setResult(res);
      if (Object.keys(res.extracted).length || res.cleared.length) locals.update(res.extracted, res.cleared);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'history', workspaceId] });
    } catch (err) {
      setResult(null);
      setStreamResult(null);
      setError(err instanceof ApiError ? err.message : 'Could not send the request');
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canEdit) {
      e.preventDefault();
      void send();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 's' && canEdit) {
      e.preventDefault();
      void save();
    }
  };

  const counts: Partial<Record<Tab, number>> = {
    params: draft.params.filter((p) => p.enabled).length,
    headers: draft.headers.filter((h) => h.enabled).length,
    checks: draft.assertions.filter((a) => a.enabled).length,
    extract: draft.extractors.filter((x) => x.enabled).length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }} onKeyDown={onKey}>
      <div className={s.crumbs}>
        {crumbs.map((c, i) => <span key={i} className="trunc">{i > 0 && '/ '}{c}</span>)}
      </div>
      <div className={s.bar}>
        <input className={`inp ${s.name}`} value={name} aria-label="Name" readOnly={!canEdit} onChange={(e) => setName(e.target.value)} />
        <select className="inp" style={{ width: 200 }} value={variationId ?? ''} aria-label="Variation" onChange={(e) => onVariation(e.target.value || null)}>
          <option value="">Base request</option>
          {node.variations.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {canEdit && (
          <>
            <button className="btn" onClick={saveAsVariation} title="Save the current edits as a new variation of this request"><Icon name="layers" size={13} />Save as variation</button>
            {variation && <button className="btn ghost danger" onClick={removeVariation} aria-label="Delete variation"><Icon name="x" size={13} /></button>}
            <button className="btn" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>
          </>
        )}
      </div>
      <div className={s.urlRow}>
        <select className={`inp ${s.methodSelect}`} style={{ width: 118 }} value={protocol} aria-label="Protocol" disabled={!canEdit} onChange={(e) => {
          const next = e.target.value as (typeof STREAM_PROTOCOLS)[number];
          patch({ protocol: next === 'http' ? undefined : next, ...(next === 'http' ? { stream: undefined } : { stream: draft.stream ?? { send: [], listenMs: 5000, maxMessages: 50 } }), ...(next === 'ws' ? { method: 'GET' as HttpMethod } : {}) });
          if (next !== 'http') setTab('stream');
          else if (tab === 'stream') setTab('params');
        }}>
          {STREAM_PROTOCOLS.map((p) => <option key={p} value={p}>{PROTOCOL_LABEL[p]}</option>)}
        </select>
        {protocol !== 'ws' && (
          <select className={`inp ${s.methodSelect} ${s[`m-${draft.method}`]}`} value={draft.method} aria-label="Method" disabled={!canEdit} onChange={(e) => patch({ method: e.target.value as HttpMethod })}>
            {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <input className={`inp ${s.url}`} value={draft.url} placeholder={protocol === 'ws' ? 'wss://{{host}}/live' : '{{baseUrl}}/path'} aria-label="URL" spellCheck={false} readOnly={!canEdit} onChange={(e) => patch({ url: e.target.value })} />
        <button className="btn" onClick={() => setCodeOpen(true)} disabled={!draft.url.trim() || !canEdit || isStream} title="This request as cURL, JavaScript, Python, Go, Java or C#"><Icon name="doc" size={12} />Code</button>
        <button className="btn primary" onClick={send} disabled={sending || !draft.url.trim() || !canEdit} title={canEdit ? 'Send (Ctrl+Enter)' : 'Sending needs permission to record results in this project'}><Icon name="play" size={12} />Send</button>
      </div>
      {node.needsReview && (
        <div className={s.notice}>
          <Icon name="alert" size={14} />
          <div style={{ flex: 1 }}>The spec changed since this request was made: {node.needsReview}. Check the request still fits, then mark it reviewed.</div>
          {canEdit && (
            <button className="btn sm" onClick={async () => {
              await api('POST', `${base}/nodes/${node.id}/reviewed`);
              refresh();
            }}>Mark reviewed</button>
          )}
        </div>
      )}
      {error && <div className={s.notice} role="alert"><Icon name="alert" size={14} />{error}</div>}
      <div className={s.split}>
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className={`tabs ${s.editorTabs}`} role="tablist" aria-label="Request">
            {TABS.filter(([t]) => t !== 'stream' || isStream).map(([t, label]) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                {label}
                {counts[t] ? <span className="n">{counts[t]}</span> : null}
                {t === 'body' && draft.body.type !== 'none' && <span className="n">{draft.body.type}</span>}
                {t === 'scripts' && (draft.scripts.pre.trim() || draft.scripts.post.trim()) && <span className="n">{[draft.scripts.pre.trim() && 'pre', draft.scripts.post.trim() && 'post'].filter(Boolean).join('+')}</span>}
              </button>
            ))}
          </div>
          <div className={s.pane} role="tabpanel">
            {tab === 'params' && <KeyValueTable rows={draft.params} readOnly={!canEdit} onChange={(params) => patch({ params })} keyLabel="Query parameter" />}
            {tab === 'headers' && <KeyValueTable rows={draft.headers} readOnly={!canEdit} onChange={(headers) => patch({ headers })} keyLabel="Header" />}
            {tab === 'body' && <BodyEditor body={draft.body} readOnly={!canEdit} onChange={(body) => patch({ body })} />}
            {tab === 'stream' && isStream && <StreamSettingsEditor def={draft} readOnly={!canEdit} onChange={(stream) => patch({ stream })} />}
            {tab === 'auth' && <AuthEditor auth={draft.auth} readOnly={!canEdit} onChange={(auth) => patch({ auth })} profiles={profiles.data ?? []} />}
            {tab === 'checks' && <AssertionsEditor rows={draft.assertions} readOnly={!canEdit} onChange={(assertions) => patch({ assertions })} />}
            {tab === 'extract' && <ExtractorsEditor rows={draft.extractors} readOnly={!canEdit} onChange={(extractors) => patch({ extractors })} />}
            {tab === 'scripts' && <ScriptsEditor scripts={draft.scripts} onChange={(scripts) => patch({ scripts })} readOnly={!canEdit} scope="request" />}
            {tab === 'settings' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360 }}>
                <div className="field">
                  <label htmlFor="rq-timeout">Timeout (ms)</label>
                  <input id="rq-timeout" className="inp" type="number" min={100} max={120000} value={draft.settings.timeoutMs} onChange={(e) => patch({ settings: { ...draft.settings, timeoutMs: Number(e.target.value) || 30000 } })} />
                </div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
                  <input type="checkbox" checked={draft.settings.followRedirects} onChange={(e) => patch({ settings: { ...draft.settings, followRedirects: e.target.checked } })} />
                  Follow redirects
                </label>
                {draft.operation && <div className="t3" style={{ fontSize: 12 }}>Made from the spec operation <span className="mono">{draft.operation.method} {draft.operation.path}</span>.</div>}
              </div>
            )}
            {tab === 'docs' && (
              <textarea className={s.code} value={draft.docs} placeholder="What this request is for, and anything a teammate should know before sending it." aria-label="Docs" onChange={(e) => patch({ docs: e.target.value })} />
            )}
          </div>
        </div>
        {isStream ? <StreamPane result={streamResult} sending={sending} /> : <ResponsePane
          result={result}
          sending={sending}
          onDetectAuth={canEdit ? async (r) => {
            try {
              const d = await api<{ found: boolean; config: unknown; explanation: string }>('POST', `${base}/assistant/detect-auth`, { historyId: r.historyId });
              if (!d.found) return notify(d.explanation, 'bad');
              const name = window.prompt(`${d.explanation}\n\nName this auth profile`, `${node.name} session`);
              if (!name?.trim()) return;
              await api('POST', `${base}/profiles`, { name: name.trim(), loginNodeId: node.id, config: d.config });
              queryClient.invalidateQueries({ queryKey: ['apitest', 'profiles', workspaceId] });
              notify('Auth profile made. Pick it in any request’s Auth tab.');
            } catch (err) {
              notify(err instanceof ApiError ? err.message : 'Could not make the profile', 'bad');
            }
          } : undefined}
          onBug={canEdit ? async (r) => {
            const summary = window.prompt('Bug summary', `${name} fails: ${r.error?.message ?? r.assertions.find((a) => !a.passed)?.message ?? ''}`.slice(0, 240));
            if (!summary?.trim()) return;
            try {
              const d = await api<{ jiraKey: string }>('POST', `${base}/history/${r.historyId}/bug`, { summary: summary.trim(), failures: [...(r.error ? [r.error.message] : []), ...r.assertions.filter((a) => !a.passed).map((a) => a.message)], found: 'API Studio' });
              notify(`Logged ${d.jiraKey} in Jira`);
            } catch (err) {
              notify(err instanceof ApiError ? err.message : 'Could not log the bug', 'bad');
            }
          } : undefined}
        />}
      </div>
      {codeOpen && <SnippetDialog base={base} nodeId={node.id} request={draft} environmentId={environmentId} locals={locals.values} onClose={() => setCodeOpen(false)} />}
    </div>
  );
}

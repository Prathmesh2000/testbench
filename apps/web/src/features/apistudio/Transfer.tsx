'use client';

import { SNIPPET_LANGS, type ApiNode, type ApiRequestDef, type ImportResult, type SnippetResult } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import s from './apistudio.module.css';

// Moving requests in and out: import (Postman, cURL), export, and code snippets (plan §4).

const LANG_LABELS: Record<(typeof SNIPPET_LANGS)[number], string> = { curl: 'cURL', fetch: 'JavaScript', python: 'Python', go: 'Go', java: 'Java', csharp: 'C#' };

/** The request as code for another tool, resolved on the server with every secret masked. */
export function SnippetDialog({ base, nodeId, request, environmentId, locals, onClose }: {
  base: string;
  nodeId: string;
  request: ApiRequestDef;
  environmentId: string | null;
  locals: Record<string, string>;
  onClose(): void;
}) {
  const { notify } = useToast();
  const [lang, setLang] = useState<(typeof SNIPPET_LANGS)[number]>('curl');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCode(null);
    setError(null);
    api<SnippetResult>('POST', `${base}/snippet`, { request, nodeId, environmentId, locals, language: lang })
      .then((r) => setCode(r.code))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not make the snippet'));
    // The request is fixed while the dialog is open; only a change of language asks again.
  }, [lang]);
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      notify('Copied');
    } catch {
      notify('Copy failed: select the text and copy it', 'bad');
    }
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={`modal center ${s.form}`} style={{ width: 760 }} role="dialog" aria-labelledby="snip-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 id="snip-title" style={{ margin: 0, fontSize: 15 }}>Code</h3>
          <div className="f1" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>
        </div>
        <div className="seg" role="radiogroup" aria-label="Language">
          {SNIPPET_LANGS.map((l) => (
            <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>{LANG_LABELS[l]}</button>
          ))}
        </div>
        {error ? <div className="err" role="alert">{error}</div> : <pre className={s.pre} style={{ maxHeight: 380, overflow: 'auto', padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--field)' }}>{code ?? 'Writing…'}</pre>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="t3" style={{ fontSize: 12, flex: 1 }}>Variables are filled in and secrets show as ••••••; replace them before running it.</span>
          <button className="btn primary" disabled={!code} onClick={copy}><Icon name="check" size={13} />Copy</button>
        </div>
      </div>
    </>
  );
}

type Format = 'postman' | 'postman-environment' | 'curl';

/** Brings in a Postman collection or environment, or a cURL command, and says what did not carry over. */
export function ImportDialog({ base, workspaceId, containers, defaultParent, onClose, onDone }: {
  base: string;
  workspaceId: string;
  containers: ApiNode[];
  defaultParent: string | null;
  onClose(): void;
  onDone(result: ImportResult): void;
}) {
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<Format>('postman');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [parentId, setParentId] = useState(defaultParent ?? containers[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const readFile = async (f: File) => {
    if (f.size > 20 * 1024 * 1024) return setError('That file is larger than 20 MB.');
    setFileName(f.name);
    setContent(await f.text());
    try {
      // Postman environment exports have "values"; collections have "item". Pick the right tab for them.
      const doc = JSON.parse(await f.text()) as Record<string, unknown>;
      if (Array.isArray(doc.values) && !doc.item) setFormat('postman-environment');
    } catch {
      // Not JSON: the import will say so.
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<ImportResult>('POST', `${base}/import`, format === 'curl' ? { format, content, parentId } : { format, content });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['apitest', 'envs', workspaceId] });
      if (res.warnings.length) setResult(res);
      else onDone(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import it');
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <>
        <div className="scrim" onClick={() => onDone(result)} />
        <div className={`modal center ${s.form}`} role="dialog" aria-labelledby="imp-done">
          <h3 id="imp-done" style={{ margin: 0, fontSize: 15 }}>Imported {result.name}</h3>
          <div className="t2" style={{ fontSize: 12.5 }}>{result.requests} request{result.requests === 1 ? '' : 's'}. Some parts did not carry over:</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, maxHeight: 300, overflow: 'auto' }}>
            {result.warnings.map((w, i) => <li key={i} style={{ marginBottom: 4 }}>{w}</li>)}
          </ul>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => onDone(result)}>Open it</button></div>
        </div>
      </>
    );

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className={`modal center ${s.form}`} onSubmit={submit} role="dialog" aria-labelledby="imp-title">
        <h3 id="imp-title" style={{ margin: 0, fontSize: 15 }}>Import</h3>
        <div className="seg" role="radiogroup" aria-label="What to import">
          {([['postman', 'Postman collection'], ['postman-environment', 'Postman environment'], ['curl', 'cURL command']] as [Format, string][]).map(([f, label]) => (
            <button type="button" key={f} role="radio" aria-checked={format === f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{label}</button>
          ))}
        </div>
        {format === 'curl' ? (
          <>
            <textarea className={s.code} spellCheck={false} value={content} aria-label="cURL command" placeholder="curl 'https://api.example.com/orders' -H 'accept: application/json'" onChange={(e) => setContent(e.target.value)} />
            <div className="field">
              <label htmlFor="imp-parent">Put it in</label>
              <select id="imp-parent" className="inp" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                {containers.map((c) => <option key={c.id} value={c.id}>{c.kind === 'folder' ? '  ' : ''}{c.name}</option>)}
              </select>
              {containers.length === 0 && <span className="err">Make a collection first.</span>}
            </div>
            <span className="t3" style={{ fontSize: 12 }}>In browser dev tools, right-click a request in the Network tab and choose Copy › Copy as cURL.</span>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input ref={input} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              <button type="button" className="btn" onClick={() => input.current?.click()}><Icon name="paperclip" size={13} />Choose file</button>
              <span className="t2 trunc" style={{ fontSize: 12.5 }}>{fileName ?? 'or paste the JSON below'}</span>
            </div>
            <textarea className={s.code} style={{ minHeight: 120 }} spellCheck={false} value={content} aria-label="Postman JSON" onChange={(e) => setContent(e.target.value)} />
            <span className="t3" style={{ fontSize: 12 }}>
              {format === 'postman'
                ? 'In Postman: ⋯ on the collection › Export › Collection v2.1. Folders, auth, variables and scripts come across; pm.* scripts keep working.'
                : 'In Postman: Environments › ⋯ › Export. Values marked secret stay secret.'}
            </span>
          </>
        )}
        {error && <div className="err" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !content.trim() || (format === 'curl' && !parentId)}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </form>
    </>
  );
}

/** Downloads a collection, folder or request as a Postman v2.1 file, without secret values. */
export async function exportNode(base: string, node: ApiNode): Promise<void> {
  const doc = await get<unknown>(`${base}/nodes/${node.id}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${node.name.replace(/[^\w.-]+/g, '_')}.postman_collection.json`;
  a.click();
  URL.revokeObjectURL(url);
}

'use client';

import type { VersionResult } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { fmt } from '@/lib/format';
import { useAiModel } from './DraftCasesDialog';
import { REQ_ID } from './docs-utils';
import s from './docs.module.css';

interface Props {
  /** The document to add a version to; omitted when importing a new PRD. */
  target?: { id: string; title: string; version: number };
  onClose(): void;
  onDone(documentId: string): void;
}

/** Import a PRD, or upload a new version of one, from a .md/.txt file or pasted text. */
export function ImportDialog({ target, onClose, onDone }: Props) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const model = useAiModel('extract_requirements');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mirrors the server's rule closely enough to warn before a slow AI extraction starts.
  const tagged = new RegExp(`(^|\\n)\\s*${REQ_ID.source}`).test(body);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setBody(await file.text());
    if (!title) setTitle(file.name.replace(/\.(md|markdown|txt)$/i, ''));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (target) {
        const r = await api<VersionResult>('POST', `/projects/${project.id}/documents/${target.id}/versions`, { body });
        notify(`v${r.version}: ${r.changed} changed, ${r.added} added, ${r.removed} removed · ${fmt(r.flagged)} cases flagged for review`);
        await queryClient.invalidateQueries({ queryKey: ['docs', project.id] });
        onDone(target.id);
      } else {
        const r = await api<{ id: string; requirements: number }>('POST', `/projects/${project.id}/documents`, { title: title.trim(), body });
        notify(`${title.trim()} imported · ${r.requirements} requirements`);
        await queryClient.invalidateQueries({ queryKey: ['docs', project.id] });
        onDone(r.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload the document');
    } finally {
      setBusy(false);
    }
  };

  const heading = target ? `Upload v${target.version + 1} of ${target.title}` : 'Import PRD';
  return (
    <>
      <div className="scrim" onClick={busy ? undefined : onClose} />
      <form className="modal center" style={{ width: 720, height: 600 }} role="dialog" aria-modal="true" aria-labelledby="imp-title" onSubmit={submit}>
        <div className={`row ${s.dlgHead}`}>
          <span id="imp-title" className="cond trunc" style={{ fontSize: 16, fontWeight: 600 }}>{heading}</span>
          <div className="f1" />
          <button type="button" className="ib" aria-label="Close" onClick={onClose} disabled={busy}><Icon name="x" /></button>
        </div>
        <div className={s.dlgBody}>
          <div className="banner info t2">
            <Icon name="info" />
            <span>
              Paragraphs that start with an id such as <span className="mono">REQ-AP-01</span> are read as requirements directly.
              Without ids, AI extracts the requirements{model ? ` (${model})` : ''}; that can take a minute with a local model.
            </span>
          </div>
          {!target && (
            <div className="field">
              <label htmlFor="imp-name">Title</label>
              <input id="imp-name" className="inp" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="UPI Autopay mandates" />
            </div>
          )}
          <div className="field">
            <label htmlFor="imp-file">File (.md or .txt)</label>
            <input id="imp-file" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={(e) => loadFile(e.target.files?.[0])} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="imp-body">Or paste the document</label>
            <textarea id="imp-body" className="inp mono" style={{ flex: 1, minHeight: 160 }} value={body} onChange={(e) => setBody(e.target.value)} placeholder={'# Title\n\n## 1. Section\nREQ-XX-01 The system …'} />
          </div>
          {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        </div>
        <div className={`row ${s.dlgFoot}`}>
          <span className="t3" style={{ fontSize: 12 }} aria-live="polite">
            {busy ? (tagged ? 'Reading requirement ids…' : `Extracting requirements${model ? ` with ${model}` : ''}…`) : body ? `${fmt(body.split(/\s+/).filter(Boolean).length)} words · ${tagged ? 'has requirement ids' : 'no requirement ids, AI will extract them'}` : ''}
          </span>
          <div className="f1" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || body.trim().length < 20 || (!target && !title.trim())}>
            {busy && <Icon name="refresh" size={12} className="spin" />}
            {busy ? 'Uploading…' : target ? 'Upload version' : 'Import'}
          </button>
        </div>
      </form>
    </>
  );
}

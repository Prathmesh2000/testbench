'use client';

import type { BoardKind, BoardRow } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession } from '@/components/providers';
import { api, ApiError, get, qs } from '@/lib/api';
import { ago } from '@/lib/format';

export const KIND_LABEL: Record<BoardKind, string> = { doc: 'Doc', sheet: 'Sheet', whiteboard: 'Whiteboard' };
const FILTERS: { kind: BoardKind | ''; label: string }[] = [
  { kind: '', label: 'All' }, { kind: 'doc', label: 'Docs' }, { kind: 'sheet', label: 'Sheets' }, { kind: 'whiteboard', label: 'Whiteboards' },
];

/** Live docs, sheets and whiteboards of the project (HLD §5.9). */
export function BoardsScreen() {
  const { project, can } = useSession();
  const router = useRouter();
  const [kind, setKind] = useState<BoardKind | ''>('');
  const [creating, setCreating] = useState(false);
  const boards = useQuery({
    queryKey: ['boards', project.id, kind],
    queryFn: () => get<BoardRow[]>(`/projects/${project.id}/boards${qs({ kind })}`),
  });

  return (
    <div className="page">
      <div className="page-h">
        <h1 className="h1">Boards</h1>
        <div className="row" role="radiogroup" aria-label="Kind" style={{ gap: 6 }}>
          {FILTERS.map((f) => (
            <button key={f.kind} role="radio" aria-checked={kind === f.kind} className={`chip ${kind === f.kind ? 'on' : ''}`} onClick={() => setKind(f.kind)}>{f.label}</button>
          ))}
        </div>
        <div className="f1" />
        {can('case.write') && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} />New board</button>}
      </div>
      <div className="panel" style={{ overflow: 'auto' }}>
        <table className="tbl">
          <thead><tr><th style={{ width: 120 }}>Kind</th><th>Title</th><th style={{ width: 180 }}>Created by</th><th style={{ width: 110 }}>Updated</th></tr></thead>
          <tbody>
            {boards.data?.map((b) => (
              <tr key={b.id} className="rw" onClick={() => router.push(`/boards/${b.id}`)}>
                <td className="t2">{KIND_LABEL[b.kind]}</td>
                <td><Link href={`/boards/${b.id}`} style={{ color: 'var(--text)' }}>{b.title}</Link></td>
                <td className="t2">{b.createdBy}</td>
                <td className="t3">{ago(b.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {boards.data?.length === 0 && (
          <div className="empty" style={{ padding: 48 }}>
            <Icon name="board" size={22} />
            <div>No boards here yet.</div>
            <div className="t3" style={{ fontSize: 12 }}>Docs, sheets and whiteboards that the whole team edits live.</div>
          </div>
        )}
        {boards.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading boards…</div>}
        {boards.error && <div className="empty err" style={{ padding: 40 }}>{boards.error.message}</div>}
      </div>
      {creating && <NewBoardDialog defaultKind={kind || 'doc'} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewBoardDialog({ defaultKind, onClose }: { defaultKind: BoardKind; onClose(): void }) {
  const { project } = useSession();
  const router = useRouter();
  const [kind, setKind] = useState<BoardKind>(defaultKind);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>('POST', `/projects/${project.id}/boards`, { kind, title });
      router.push(`/boards/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the board');
      setSaving(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="modal center" style={{ width: 460 }} role="dialog" aria-label="New board" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="row" style={{ height: 48, padding: '0 12px 0 18px', borderBottom: '1px solid var(--border)' }}>
          <span className="cond" style={{ fontSize: 16, fontWeight: 600 }}>New board</span>
          <div className="f1" />
          <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="col" style={{ padding: '16px 18px', gap: 12 }}>
          <div className="field">
            <span className="flab">Kind</span>
            <div className="seg" role="radiogroup" aria-label="Kind">
              {(Object.keys(KIND_LABEL) as BoardKind[]).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="nb-title">Title</label>
            <input id="nb-title" className="inp" style={{ height: 32 }} autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Test strategy — Release 4.18" />
          </div>
          {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        </div>
        <div className="row" style={{ height: 52, padding: '0 16px', borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving || !title.trim()}>{saving ? 'Creating…' : 'Create board'}</button>
        </div>
      </form>
    </>
  );
}

'use client';

import type { BoardRow } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { KIND_LABEL } from './BoardsScreen';
import { useBoardDoc } from './collab';
import { DocEditor } from './DocEditor';
import { Presence } from './Presence';
import { SheetEditor } from './SheetEditor';
import s from './boards.module.css';

const Whiteboard = dynamic(() => import('./Whiteboard'), {
  ssr: false,
  loading: () => <div className="empty t3 f1">Loading whiteboard…</div>,
});

/** One board: its title and archive controls, and the live editor for its kind. */
export function BoardScreen({ boardId }: { boardId: string }) {
  const { project, can } = useSession();
  const { theme } = usePrefs();
  const board = useQuery({ queryKey: ['board', project.id, boardId], queryFn: () => get<BoardRow>(`/projects/${project.id}/boards/${boardId}`) });
  const collab = useBoardDoc(boardId);
  const { doc, provider, user, canEdit } = collab;

  if (board.error) {
    return <div className="page"><div className="empty" style={{ flex: 1 }}><div className="h1">Board not found</div><Link href="/boards">Back to boards</Link></div></div>;
  }

  return (
    <div className={s.board}>
      <div className={s.bhead}>
        <Link href="/boards" className="h1" style={{ color: 'var(--text)' }}>Boards</Link>
        <span className="t3">/</span>
        {board.data && <TitleField board={board.data} editable={can('case.write')} />}
        {board.data && <span className="lbl">{KIND_LABEL[board.data.kind]}</span>}
        <div className="f1" />
        <Presence board={collab} />
        {board.data && can('case.write') && <ArchiveButton boardId={boardId} />}
      </div>
      {collab.status === 'failed' && !doc && <div className="empty f1"><Icon name="plug" size={22} /><div>{collab.error}</div></div>}
      {doc && provider && user && board.data?.kind === 'doc' && (
        <div className={s.docScroll}><DocEditor doc={doc} provider={provider} user={user} canEdit={canEdit} /></div>
      )}
      {doc && board.data?.kind === 'sheet' && <SheetEditor doc={doc} canEdit={canEdit} />}
      {doc && board.data?.kind === 'whiteboard' && <Whiteboard doc={doc} canEdit={canEdit} theme={theme} />}
    </div>
  );
}

/** Inline title editor; saves on Enter or blur. */
function TitleField({ board, editable }: { board: BoardRow; editable: boolean }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(board.title);

  const save = async () => {
    const next = title.trim();
    if (!next || next === board.title) return setTitle(board.title);
    try {
      await api('PATCH', `/projects/${project.id}/boards/${board.id}`, { title: next });
      await queryClient.invalidateQueries({ queryKey: ['board', project.id, board.id] });
      await queryClient.invalidateQueries({ queryKey: ['boards', project.id] });
    } catch (err) {
      setTitle(board.title);
      notify(err instanceof ApiError ? err.message : 'Could not rename the board', 'bad');
    }
  };

  if (!editable) return <span className={s.title}>{board.title}</span>;
  return (
    <input
      className={s.titleInput}
      aria-label="Board title"
      maxLength={200}
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setTitle(board.title); e.currentTarget.blur(); }
      }}
    />
  );
}

/** Archive with an inline second click instead of a browser confirm. */
function ArchiveButton({ boardId }: { boardId: string }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [asking, setAsking] = useState(false);

  const archive = async () => {
    try {
      await api('PATCH', `/projects/${project.id}/boards/${boardId}`, { archived: true });
      await queryClient.invalidateQueries({ queryKey: ['boards', project.id] });
      notify('Board archived');
      router.push('/boards');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not archive the board', 'bad');
    }
  };

  if (!asking) return <button className="btn sm" onClick={() => setAsking(true)}>Archive</button>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <button className="btn sm danger" onClick={archive} autoFocus>Archive board</button>
      <button className="btn sm" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

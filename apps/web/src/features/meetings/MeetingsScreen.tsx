'use client';

import { PRIORITIES, type ActionItem, type MeetingDetail, type MeetingRow, type Priority } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar } from '@/components/status';
import { useBoardDoc } from '@/features/boards/collab';
import { DocEditor } from '@/features/boards/DocEditor';
import { Presence } from '@/features/boards/Presence';
import { useMembers, useModules } from '@/features/cases/data';
import { api, ApiError, get } from '@/lib/api';
import { dateTimeIST, minutesLabel } from '@/lib/format';
import { ScheduleDialog } from './ScheduleDialog';
import s from './meetings.module.css';

const endOf = (m: MeetingRow) => new Date(m.startsAt).getTime() + m.minutes * 60_000;
const timeIST = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

/** Meetings of the project, split into upcoming and past, with the selected one (`?m=`) on the right. */
export function MeetingsScreen() {
  const { project, can } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get('m');
  const [scheduling, setScheduling] = useState(false);
  const meetings = useQuery({ queryKey: ['meetings', project.id], queryFn: () => get<MeetingRow[]>(`/projects/${project.id}/meetings`) });

  const select = (id: string | null) => router.replace(id ? `${pathname}?m=${id}` : pathname, { scroll: false });
  const now = Date.now();
  const upcoming = (meetings.data ?? []).filter((m) => endOf(m) >= now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = (meetings.data ?? []).filter((m) => endOf(m) < now);

  const list = (title: string, rows: MeetingRow[]) => (
    <section>
      <div className="sec" style={{ padding: '14px 18px 6px' }}>{title} · {rows.length}</div>
      {rows.map((m) => (
        <button key={m.id} className={`${s.mrow} ${m.id === selected ? s.on : ''}`} aria-current={m.id === selected} onClick={() => select(m.id)}>
          <span className={s.when}>{dateTimeIST(m.startsAt).replace(' IST', '')}</span>
          <span className="col f1" style={{ gap: 2, minWidth: 0 }}>
            <span className="row" style={{ gap: 6 }}>
              <b className="trunc" style={{ fontWeight: 500 }}>{m.title}</b>
              {now >= new Date(m.startsAt).getTime() && now < endOf(m) && <span className={s.live}><i />Live</span>}
            </span>
            <span className="t3 trunc" style={{ fontSize: 11.5 }}>{minutesLabel(m.minutes)}{m.context ? ` · ${m.context}` : ''}</span>
          </span>
          {m.openItems > 0 && <span className="lbl" title="Open action items">{m.openItems} open</span>}
          <span className="avs">{m.attendees.slice(0, 3).map((a) => <Avatar key={a.id} user={{ ...a, email: '' }} />)}</span>
        </button>
      ))}
      {rows.length === 0 && <div className="t3" style={{ padding: '4px 18px 10px', fontSize: 12 }}>None.</div>}
    </section>
  );

  return (
    <div className={s.layout}>
      <div className={s.head}>
        <h1 className="h1">Meetings</h1>
        <div className="f1" />
        {can('case.write') && <button className="btn primary" onClick={() => setScheduling(true)}><Icon name="plus" size={14} />Schedule meeting</button>}
      </div>
      <div className={s.body}>
        <div className={s.list}>
          {meetings.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading meetings…</div>}
          {meetings.error && <div className="empty err" style={{ padding: 40 }}>{meetings.error.message}</div>}
          {meetings.data && list('Upcoming', upcoming)}
          {meetings.data && list('Past', past)}
        </div>
        <aside className={s.mpane} aria-label="Meeting">
          {selected
            ? <MeetingPane key={selected} meetingId={selected} onClose={() => select(null)} />
            : <div className="empty f1" style={{ padding: 24 }}><Icon name="calendar" size={22} /><div>Select a meeting</div><div className="t3" style={{ fontSize: 12 }}>Attendees, live notes and action items appear here.</div></div>}
        </aside>
      </div>
      {scheduling && <ScheduleDialog onClose={() => setScheduling(false)} onCreated={(id) => { setScheduling(false); select(id); }} />}
    </div>
  );
}

function MeetingPane({ meetingId, onClose }: { meetingId: string; onClose(): void }) {
  const { project } = useSession();
  const detail = useQuery({ queryKey: ['meeting', project.id, meetingId], queryFn: () => get<MeetingDetail>(`/projects/${project.id}/meetings/${meetingId}`) });
  const m = detail.data;
  if (detail.error) return <div className="empty err f1">{detail.error.message}</div>;
  if (!m) return <div className="empty t3 f1">Loading…</div>;
  const start = new Date(m.startsAt).getTime();
  const live = Date.now() >= start && Date.now() < endOf(m);

  return (
    <>
      <div className={s.phead}>
        <div className="row" style={{ gap: 8 }}>
          {m.context && <span className="pill">{m.context}</span>}
          {live && <span className={s.live}><i />Live now</span>}
          <div className="f1" />
          <button className="ib sm" aria-label="Close" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, marginTop: 8 }}>{m.title}</div>
        <div className="t3" style={{ fontSize: 12 }}>{dateTimeIST(m.startsAt).replace(' IST', '')}–{timeIST(endOf(m))} IST · {minutesLabel(m.minutes)}</div>
        <div className="t3" style={{ fontSize: 12 }}>Calendar: {m.calendar}</div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <details className={s.cs} open>
          <summary><span className="sec">Attendees</span><div className="f1" /><span className="t3">{m.attendees.length}</span></summary>
          <div className="col" style={{ gap: 6, padding: '0 16px 12px', fontSize: 12.5 }}>
            {m.attendees.map((a) => <div key={a.id} className="row"><Avatar user={{ ...a, email: '' }} /><span className="f1">{a.name}</span></div>)}
            {m.attendees.length === 0 && <span className="t3">Nobody invited.</span>}
          </div>
        </details>
        <details className={s.cs} open>
          <summary><span className="sec">Live notes</span><div className="f1" /></summary>
          <div style={{ padding: '0 16px 12px' }}><Notes boardId={m.notesBoardId} /></div>
        </details>
        <details className={s.cs} open>
          <summary><span className="sec">Action items</span><div className="f1" /><span className="t3">{m.actionItems.length}</span></summary>
          <div style={{ padding: '0 16px 12px' }}><ActionItems meeting={m} /></div>
        </details>
      </div>
    </>
  );
}

/** The meeting's notes: a live doc board, same editor as the Boards screen. */
function Notes({ boardId }: { boardId: string }) {
  const board = useBoardDoc(boardId);
  return (
    <div className="col" style={{ gap: 6 }}>
      <Presence board={board} compact />
      {board.doc && board.provider && board.user
        ? <DocEditor doc={board.doc} provider={board.provider} user={board.user} canEdit={board.canEdit} compact />
        : <div className="t3" style={{ fontSize: 12 }}>{board.error ?? 'Opening notes…'}</div>}
    </div>
  );
}

function ActionItems({ meeting }: { meeting: MeetingDetail }) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const members = useMembers(project.id);
  const [text, setText] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [converting, setConverting] = useState<string | null>(null);
  const editable = can('case.write');
  const base = `/projects/${project.id}/meetings/${meeting.id}/items`;

  const run = async (work: () => Promise<unknown>, failure: string) => {
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: ['meeting', project.id, meeting.id] });
      await queryClient.invalidateQueries({ queryKey: ['meetings', project.id] });
      return true;
    } catch (err) {
      notify(err instanceof ApiError ? err.message : failure, 'bad');
      return false;
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api('POST', base, { text, assigneeId: assigneeId || null }), 'Could not add the item')) {
      setText('');
      setAssigneeId('');
    }
  };

  return (
    <div className="col">
      {meeting.actionItems.map((a) => (
        <div key={a.id} className={s.ai}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            {a.status !== 'converted' && (
              <input
                type="checkbox"
                className="cb"
                style={{ marginTop: 2 }}
                checked={a.status === 'done'}
                disabled={!editable}
                aria-label={a.status === 'done' ? 'Reopen' : 'Mark done'}
                onChange={() => run(() => api('PATCH', `${base}/${a.id}`, { status: a.status === 'done' ? 'open' : 'done' }), 'Could not update the item')}
              />
            )}
            <span className="f1" style={a.status === 'done' ? { textDecoration: 'line-through', color: 'var(--text3)' } : undefined}>{a.text}</span>
            {editable && <button className="ib sm" aria-label="Delete item" onClick={() => run(() => api('DELETE', `${base}/${a.id}`), 'Could not delete the item')}><Icon name="x" size={12} /></button>}
          </div>
          <div className="row t3" style={{ gap: 6, fontSize: 11.5 }}>
            {a.assignee ? <><Avatar user={{ ...a.assignee, email: '' }} />{a.assignee.name}</> : 'Unassigned'}
            {a.status === 'converted' && a.convertedTo && <Converted to={a.convertedTo} />}
          </div>
          {editable && a.status === 'open' && converting !== a.id && (
            <div className="row" style={{ gap: 4 }}>
              <span className="t3" style={{ fontSize: 11.5 }}>Convert to</span>
              <button className="btn sm" onClick={() => setConverting(a.id)}>Test case</button>
              <button className="btn sm" onClick={() => run(async () => notify(`Converted to ${(await api<{ convertedTo: string }>('POST', `${base}/${a.id}/convert`, { to: 'task' })).convertedTo}`), 'Could not convert the item')}>Task</button>
            </div>
          )}
          {converting === a.id && <ConvertToCase item={a} base={base} onDone={(ok) => { if (ok) setConverting(null); }} onCancel={() => setConverting(null)} run={run} />}
        </div>
      ))}
      {meeting.actionItems.length === 0 && <div className="t3" style={{ fontSize: 12, padding: '4px 0 8px' }}>No action items yet.</div>}
      {editable && (
        <form className="col" style={{ gap: 6, paddingTop: 10 }} onSubmit={add}>
          <input className="inp" aria-label="New action item" placeholder="Add an action item…" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ gap: 6 }}>
            <select className="inp f1" aria-label="Assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {members.data?.map((mb) => <option key={mb.user.id} value={mb.user.id}>{mb.user.name}</option>)}
            </select>
            <button type="submit" className="btn sm primary" disabled={!text.trim()}>Add</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** "case:TC-123" links to the case; anything else is shown as-is. */
function Converted({ to }: { to: string }) {
  const key = to.startsWith('case:') ? to.slice(5) : null;
  return (
    <span className="st st-passed" style={{ marginLeft: 'auto' }}>
      <Icon name="check" size={12} />
      {key ? <>Case <Link className="mono" href={`/cases/${key}`}>{key}</Link></> : `Converted to ${to}`}
    </span>
  );
}

interface ConvertProps {
  item: ActionItem;
  base: string;
  run(work: () => Promise<unknown>, failure: string): Promise<boolean>;
  onDone(ok: boolean): void;
  onCancel(): void;
}

/** Inline form: which module and priority the new draft case gets. */
function ConvertToCase({ item, base, run, onDone, onCancel }: ConvertProps) {
  const { project } = useSession();
  const { notify } = useToast();
  const modules = useModules(project.id);
  const options = [...(modules.data?.byId.values() ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const [moduleId, setModuleId] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const chosen = moduleId || options[0]?.id || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onDone(await run(async () => {
      const { convertedTo } = await api<{ convertedTo: string }>('POST', `${base}/${item.id}/convert`, { to: 'case', moduleId: chosen, priority });
      notify(`${convertedTo.replace('case:', '')} created as a draft case`);
    }, 'Could not convert the item'));
  };

  return (
    <form className="col" style={{ gap: 6 }} onSubmit={submit}>
      <select className="inp" aria-label="Module" value={chosen} onChange={(e) => setModuleId(e.target.value)}>
        {options.map((m) => <option key={m.id} value={m.id}>{m.path}</option>)}
      </select>
      <div className="row" style={{ gap: 6 }}>
        <div className="seg" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((p) => <button key={p} type="button" role="radio" aria-checked={priority === p} className={priority === p ? 'on' : ''} onClick={() => setPriority(p)}>{p}</button>)}
        </div>
        <div className="f1" />
        <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={!chosen}>Create case</button>
      </div>
    </form>
  );
}

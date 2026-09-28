'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { useMembers } from '@/features/cases/data';
import { api, ApiError } from '@/lib/api';
import s from './meetings.module.css';

const DURATIONS = [15, 30, 45, 60, 90];

/** Today's date in IST as YYYY-MM-DD, the value format of <input type="date">. */
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** Schedules a meeting; the time is entered in IST whatever the browser's zone is. */
export function ScheduleDialog({ onClose, onCreated }: { onClose(): void; onCreated(id: string): void }) {
  const { project, me } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const members = useMembers(project.id);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayIST);
  const [time, setTime] = useState('15:00');
  const [minutes, setMinutes] = useState(30);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([me.user.id]);
  const [context, setContext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const people = members.data?.map((m) => m.user) ?? [me.user];
  const chosen = people.filter((p) => attendeeIds.includes(p.id));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>('POST', `/projects/${project.id}/meetings`, {
        title,
        startsAt: `${date}T${time}:00+05:30`,
        minutes,
        attendeeIds,
        context: context.trim() || undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ['meetings', project.id] });
      notify('Meeting scheduled');
      onCreated(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not schedule the meeting');
      setSaving(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="modal center" style={{ width: 620 }} role="dialog" aria-label="Schedule meeting" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="row" style={{ height: 48, padding: '0 12px 0 18px', borderBottom: '1px solid var(--border)' }}>
          <span className="cond" style={{ fontSize: 16, fontWeight: 600 }}>Schedule meeting</span>
          <div className="f1" />
          <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="col" style={{ padding: '16px 18px', gap: 12 }}>
          <div className="field">
            <label htmlFor="sm-title">Title</label>
            <input id="sm-title" className="inp" style={{ height: 32 }} autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Bug triage — PAY-4944 follow-up" />
          </div>
          <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field f1">
              <label htmlFor="sm-date">Date</label>
              <input id="sm-date" type="date" className="inp" required value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sm-time">Start (IST)</label>
              <input id="sm-time" type="time" className="inp mono" required style={{ width: 110 }} value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="field">
              <span className="flab">Duration</span>
              <div className="seg" role="radiogroup" aria-label="Duration">
                {DURATIONS.map((d) => <button key={d} type="button" role="radio" aria-checked={minutes === d} className={minutes === d ? 'on' : ''} onClick={() => setMinutes(d)}>{d}m</button>)}
              </div>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sm-people">Attendees</label>
            <div className={s.people}>
              {chosen.map((p) => (
                <span key={p.id} className="lbl" style={{ height: 22, gap: 4 }}>
                  {p.name}
                  <button type="button" className={s.unpick} aria-label={`Remove ${p.name}`} onClick={() => setAttendeeIds((ids) => ids.filter((i) => i !== p.id))}><Icon name="x" size={10} /></button>
                </span>
              ))}
              <select
                id="sm-people"
                className={s.addPerson}
                value=""
                onChange={(e) => e.target.value && setAttendeeIds((ids) => [...ids, e.target.value])}
              >
                <option value="">Add people…</option>
                {people.filter((p) => !attendeeIds.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="sm-context">About</label>
            <input id="sm-context" className="inp" maxLength={120} value={context} onChange={(e) => setContext(e.target.value)} placeholder="RUN-231, build 8812 or UPI Autopay v3" />
          </div>
          {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
        </div>
        <div className="row" style={{ height: 54, padding: '0 16px', borderTop: '1px solid var(--border)' }}>
          <span className="t3" style={{ fontSize: 12 }}>Invites go out from the connected calendar</span>
          <div className="f1" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving || !title.trim() || !date || !time}>{saving ? 'Scheduling…' : 'Schedule'}</button>
        </div>
      </form>
    </>
  );
}

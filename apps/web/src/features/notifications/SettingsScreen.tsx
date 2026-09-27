'use client';

import { CHANNEL_LABELS, NOTIFY_EVENT_TYPES, NOTIFY_EVENTS, USER_CHANNELS, type Preferences, type UserChannel } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { usePrefs, useSession, useToast } from '@/components/providers';
import { AiSettings } from '@/features/ai/AiSettings';
import { api, ApiError, get } from '@/lib/api';
import s from './notify.module.css';

/** Personal settings (notifications, quiet hours, display) and the organisation's AI settings. */
export function SettingsScreen() {
  const { me, can } = useSession();
  const prefs = usePrefs();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const stored = useQuery({ queryKey: ['notify-prefs'], queryFn: () => get<Preferences>('/me/notification-preferences'), retry: false });
  const [draft, setDraft] = useState<Preferences>({ muted: {}, quietHours: null });
  useEffect(() => { if (stored.data) setDraft(stored.data); }, [stored.data]);

  const events = NOTIFY_EVENT_TYPES.filter((e) => e !== 'test.message');
  const isOn = (event: string, channel: UserChannel) => !(draft.muted[event] ?? []).includes(channel);
  const toggle = (event: string, channel: UserChannel) => {
    const current = draft.muted[event] ?? [];
    setDraft({ ...draft, muted: { ...draft.muted, [event]: current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel] } });
  };
  const save = async () => {
    try {
      await api('PUT', '/me/notification-preferences', draft);
      await queryClient.invalidateQueries({ queryKey: ['notify-prefs'] });
      notify('Preferences saved');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save', 'bad');
    }
  };

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-h"><div><h1 className="h1">Settings</h1><div className="t3" style={{ fontSize: 12, marginTop: 2 }}>{me.user.name} · {me.user.email}</div></div></div>

      <section className="panel">
        <div className="hdr"><h3>Notifications</h3><div className="f1" /><span className="t3" style={{ fontSize: 11.5 }}>Team channels (Slack, Teams, Discord, SMS) are set by admins</span></div>
        {stored.error ? (
          <div className="empty t3" style={{ padding: 24 }}>{stored.error instanceof ApiError ? stored.error.message : 'Notification settings are not available.'}</div>
        ) : (
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <table className={`tbl ${s.matrix}`}>
              <thead><tr><th>Event</th>{USER_CHANNELS.map((c) => <th key={c} style={{ textAlign: 'center' }}>{CHANNEL_LABELS[c]}</th>)}</tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e}>
                    <td>{NOTIFY_EVENTS[e].label}</td>
                    {USER_CHANNELS.map((c) => (
                      <td key={c}><input type="checkbox" className="cb" checked={isOn(e, c)} onChange={() => toggle(e, c)} aria-label={`${NOTIFY_EVENTS[e].label} by ${CHANNEL_LABELS[c]}`} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" className="cb" checked={!!draft.quietHours} onChange={(e) => setDraft({ ...draft, quietHours: e.target.checked ? { start: '22:00', end: '08:00' } : null })} />
                Quiet hours
              </label>
              {draft.quietHours && (
                <>
                  <input type="time" className="inp" value={draft.quietHours.start} onChange={(e) => setDraft({ ...draft, quietHours: { ...draft.quietHours!, start: e.target.value } })} aria-label="Quiet hours start" />
                  <span className="t3">to</span>
                  <input type="time" className="inp" value={draft.quietHours.end} onChange={(e) => setDraft({ ...draft, quietHours: { ...draft.quietHours!, end: e.target.value } })} aria-label="Quiet hours end" />
                  <span className="t3" style={{ fontSize: 12 }}>IST · email waits; in-app still arrives</span>
                </>
              )}
            </div>
            <div className="row"><button className="btn primary" onClick={save}>Save preferences</button></div>
          </div>
        )}
      </section>

      {can('ai.use') && <AiSettings />}

      <section className="panel">
        <div className="hdr"><h3>Display</h3></div>
        <div className="row" style={{ padding: 14, gap: 14, flexWrap: 'wrap' }}>
          <div className="seg" role="radiogroup" aria-label="Theme">
            <button className={prefs.theme === 'dark' ? 'on' : ''} onClick={() => prefs.theme !== 'dark' && prefs.toggleTheme()}><Icon name="moon" size={12} />Dark</button>
            <button className={prefs.theme === 'light' ? 'on' : ''} onClick={() => prefs.theme !== 'light' && prefs.toggleTheme()}><Icon name="sun" size={12} />Light</button>
          </div>
          <div className="seg" role="radiogroup" aria-label="Row density">
            <button className={prefs.density === 'compact' ? 'on' : ''} onClick={() => prefs.density !== 'compact' && prefs.toggleDensity()}>Compact rows</button>
            <button className={prefs.density === 'comfy' ? 'on' : ''} onClick={() => prefs.density !== 'comfy' && prefs.toggleDensity()}>Comfortable rows</button>
          </div>
        </div>
      </section>
    </div>
  );
}

'use client';

import {
  CHANNEL_LABELS, CHANNELS, NOTIFY_EVENT_TYPES, NOTIFY_EVENTS, TEAM_CHANNELS, USER_CHANNELS,
  type Channel, type ChannelConfig, type Delivery, type NotifyEvent, type Rule, type RuleBody, type Template, type TeamChannel, type UserChannel,
} from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, dateTimeIST } from '@/lib/format';
import s from './notify.module.css';

type Tab = 'rules' | 'templates' | 'log' | 'channels';

/**
 * The notification console (HLD §5.12): what triggers messages, what they say, where they go, and what
 * actually happened. It only talks to the notification service's API (through core-api), so it can
 * later move to its own static app without changes.
 */
export function NotificationConsole() {
  const { project, can } = useSession();
  const [tab, setTab] = useState<Tab>('rules');
  if (!can('project.manage')) {
    return <div className="page"><div className="empty" style={{ flex: 1 }}><Icon name="shield" size={22} /><div>Only project and org admins can change notification settings.</div><div className="t3">Your own preferences are in Settings.</div></div></div>;
  }
  const base = `/projects/${project.id}/notify`;
  return (
    <div className="page" style={{ gap: 12 }}>
      <div className="page-h">
        <div>
          <h1 className="h1">Notification console</h1>
          <div className="t3" style={{ fontSize: 12, marginTop: 2 }}>Email, SMS, Slack, Microsoft Teams, Discord and in-app, for the whole organisation.</div>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['rules', 'templates', 'log', 'channels'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {{ rules: 'Rules', templates: 'Templates', log: 'Delivery log', channels: 'Channels' }[t]}
          </button>
        ))}
      </div>
      {tab === 'rules' && <Rules base={base} />}
      {tab === 'templates' && <Templates base={base} />}
      {tab === 'log' && <DeliveryLog base={base} />}
      {tab === 'channels' && <Channels base={base} />}
    </div>
  );
}

// ---------- rules ----------

const emptyRule: RuleBody = { name: '', event: 'run.assigned', condition: '', userChannels: ['inapp'], teamChannels: [], fallbackMinutes: null, enabled: true };

function Rules({ base }: { base: string }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['notify-rules', base], queryFn: () => get<Rule[]>(`${base}/rules`) });
  const [editing, setEditing] = useState<{ id: string | null; body: RuleBody } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing && rules.data?.[0]) setEditing({ id: rules.data[0].id, body: rules.data[0] });
  }, [rules.data, editing]);

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      const saved = await api<Rule>(editing.id ? 'PUT' : 'POST', editing.id ? `${base}/rules/${editing.id}` : `${base}/rules`, editing.body);
      await queryClient.invalidateQueries({ queryKey: ['notify-rules', base] });
      setEditing({ id: saved.id, body: saved });
      notify(`Saved “${saved.name}” (version ${saved.version})`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the rule');
    }
  };
  const remove = async () => {
    if (!editing?.id) return;
    await api('DELETE', `${base}/rules/${editing.id}`);
    await queryClient.invalidateQueries({ queryKey: ['notify-rules', base] });
    setEditing(null);
    notify('Rule deleted');
  };
  const set = (patch: Partial<RuleBody>) => editing && setEditing({ ...editing, body: { ...editing.body, ...patch } });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const r = editing?.body;

  return (
    <div className={s.split}>
      <div className="panel" style={{ overflow: 'hidden', alignSelf: 'flex-start' }}>
        <div className="hdr"><h3>Rules</h3><div className="f1" /><button className="btn sm" onClick={() => setEditing({ id: null, body: emptyRule })}><Icon name="plus" size={12} />New rule</button></div>
        {rules.data?.map((rule) => (
          <button key={rule.id} className={`${s.item} ${editing?.id === rule.id ? s.on : ''}`} onClick={() => setEditing({ id: rule.id, body: rule })}>
            <span className={`dot ${rule.enabled ? 'ok' : ''}`} style={{ background: rule.enabled ? undefined : 'var(--text3)' }} />
            <span className="col f1" style={{ gap: 2, minWidth: 0 }}>
              <span className="trunc" style={{ fontWeight: 500 }}>{rule.name}</span>
              <span className="t3 trunc" style={{ fontSize: 11.5 }}>{NOTIFY_EVENTS[rule.event].label} → {[...rule.userChannels, ...rule.teamChannels].map((c) => CHANNEL_LABELS[c]).join(', ') || 'nowhere'}</span>
            </span>
            <span className="mono t3" style={{ fontSize: 11 }}>v{rule.version}</span>
          </button>
        ))}
        {rules.error && <div className="empty t3" style={{ padding: 24 }}>{rules.error instanceof ApiError ? rules.error.message : 'Could not load rules.'}</div>}
      </div>

      {r && (
        <div className="panel">
          <div className="hdr"><h3>{editing.id ? 'Edit rule' : 'New rule'}</h3><div className="f1" />
            <label className="row" style={{ gap: 6, fontSize: 12 }}><input type="checkbox" className="cb" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Enabled</label>
          </div>
          <div className={s.form}>
            <div className="field"><label htmlFor="rule-name">Name</label><input id="rule-name" className="inp" value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Release blocker logged" /></div>
            <div className="field">
              <label htmlFor="rule-event">When</label>
              <select id="rule-event" className="inp" value={r.event} onChange={(e) => set({ event: e.target.value as NotifyEvent })}>
                {NOTIFY_EVENT_TYPES.map((ev) => <option key={ev} value={ev}>{NOTIFY_EVENTS[ev].label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rule-cond">Only if <span className="t3" style={{ fontWeight: 400 }}>· optional</span></label>
              <input id="rule-cond" className="inp mono" value={r.condition} onChange={(e) => set({ condition: e.target.value })} placeholder="severity IN (Blocker, Critical)" />
              <span className="t3" style={{ fontSize: 11.5 }}>Fields you can use: {Object.keys(NOTIFY_EVENTS[r.event].sample).join(', ')}</span>
            </div>
            <div className="field">
              <span className="flab">Tell the people concerned by</span>
              <div className="row" style={{ gap: 6 }}>{USER_CHANNELS.map((c) => <button key={c} className={`chip ${r.userChannels.includes(c) ? 'on' : ''}`} onClick={() => set({ userChannels: toggle<UserChannel>(r.userChannels, c) })}>{CHANNEL_LABELS[c]}</button>)}</div>
            </div>
            {r.userChannels.includes('inapp') && !r.userChannels.includes('email') && (
              <div className="field">
                <span className="flab">If still unread, email them after</span>
                <div className="row" style={{ gap: 6 }}>
                  <select className="inp" aria-label="Fallback delay" value={r.fallbackMinutes ?? ''} onChange={(e) => set({ fallbackMinutes: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Never</option>{[5, 10, 15].map((m) => <option key={m} value={m}>{m} minutes</option>)}
                  </select>
                </div>
              </div>
            )}
            <div className="field">
              <span className="flab">Also post to team channels</span>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{TEAM_CHANNELS.map((c) => <button key={c} className={`chip ${r.teamChannels.includes(c) ? 'on' : ''}`} onClick={() => set({ teamChannels: toggle<TeamChannel>(r.teamChannels, c) })}>{CHANNEL_LABELS[c]}</button>)}</div>
            </div>
            <div className="note">People can mute channels and set quiet hours in their own settings; those apply after this rule. Each change is saved as a new version, and the delivery log shows which version sent each message.</div>
            {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
            <div className="row">
              <button className="btn primary" onClick={save} disabled={!r.name.trim()}>Save rule</button>
              {editing.id && <button className="btn danger" onClick={remove}>Delete</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- templates ----------

function Templates({ base }: { base: string }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const templates = useQuery({ queryKey: ['notify-templates', base], queryFn: () => get<Template[]>(`${base}/templates`) });
  const [event, setEvent] = useState<NotifyEvent>('defect.fixed');
  const [channel, setChannel] = useState<Channel>('email');
  const current = templates.data?.find((t) => t.event === event && t.channel === channel);
  const [draft, setDraft] = useState({ subject: '', body: '' });
  useEffect(() => { if (current) setDraft({ subject: current.subject, body: current.body }); }, [current]);

  const preview = useQuery({
    queryKey: ['notify-preview', base, event, channel, draft],
    queryFn: () => api<{ title: string; body: string }>('POST', `${base}/templates/preview`, { event, channel, ...draft }),
    enabled: !!draft.body,
  });

  const save = async (reset = false) => {
    await api(reset ? 'DELETE' : 'PUT', `${base}/templates/${event}/${channel}`, reset ? undefined : draft);
    await queryClient.invalidateQueries({ queryKey: ['notify-templates', base] });
    notify(reset ? 'Back to the built-in text' : 'Template saved');
  };

  return (
    <div className={s.split}>
      <div className="panel" style={{ overflow: 'hidden', alignSelf: 'flex-start' }}>
        <div className="hdr"><h3>Events</h3></div>
        {NOTIFY_EVENT_TYPES.map((ev) => <button key={ev} className={`${s.item} ${ev === event ? s.on : ''}`} onClick={() => setEvent(ev)}><span className="trunc">{NOTIFY_EVENTS[ev].label}</span></button>)}
      </div>
      <div className="col" style={{ gap: 12, minWidth: 0 }}>
        <div className="seg" role="radiogroup" aria-label="Channel">
          {CHANNELS.map((c) => <button key={c} role="radio" aria-checked={c === channel} className={c === channel ? 'on' : ''} onClick={() => setChannel(c)}>{CHANNEL_LABELS[c]}</button>)}
        </div>
        <div className={s.editor}>
          <div className="panel col" style={{ padding: 14, gap: 10 }}>
            <div className="row"><b style={{ fontSize: 12.5 }}>Template</b>{current?.customised ? <span className="pill">Customised</span> : <span className="t3" style={{ fontSize: 11.5 }}>Built-in</span>}</div>
            <div className="field"><label htmlFor="tpl-subject">{channel === 'email' ? 'Subject' : 'Title'}</label><input id="tpl-subject" className="inp mono" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></div>
            <div className="field"><label htmlFor="tpl-body">Message</label><textarea id="tpl-body" className="inp mono" rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></div>
            <div className="t3" style={{ fontSize: 11.5 }}>Placeholders: {Object.keys(NOTIFY_EVENTS[event].sample).map((k) => `{{${k}}}`).join(' ')}</div>
            <div className="row">
              <button className="btn primary" onClick={() => save()} disabled={!draft.body.trim()}>Save template</button>
              {current?.customised && <button className="btn" onClick={() => save(true)}>Reset to built-in</button>}
            </div>
          </div>
          <div className="panel col" style={{ padding: 14, gap: 8 }}>
            <b style={{ fontSize: 12.5 }}>Preview with sample data</b>
            <div className={s.preview}>
              <div style={{ fontWeight: 600 }}>{preview.data?.title}</div>
              <div className="t2" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{preview.data?.body}</div>
              {channel !== 'sms' && <div style={{ marginTop: 10 }}><span className="btn sm">Open in Testbench</span></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- delivery log ----------

const STATUS_CLASS: Record<Delivery['status'], string> = { delivered: 'st-passed', failed: 'st-failed', retrying: 'st-blocked', suppressed: 'st-skipped', queued: 'st-untested' };

function DeliveryLog({ base }: { base: string }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [status, setStatus] = useState<Delivery['status'] | 'all'>('all');
  const log = useQuery({ queryKey: ['notify-log', base], queryFn: () => get<Delivery[]>(`${base}/deliveries`), refetchInterval: 5_000 });
  const rows = useMemo(() => (log.data ?? []).filter((d) => (channel === 'all' || d.channel === channel) && (status === 'all' || d.status === status)), [log.data, channel, status]);

  const resend = async (id: string) => {
    await api('POST', `${base}/deliveries/resend`, { id });
    await queryClient.invalidateQueries({ queryKey: ['notify-log', base] });
    notify('Queued again');
  };

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {(['all', ...CHANNELS] as const).map((c) => <button key={c} className={`chip ${channel === c ? 'on' : ''}`} onClick={() => setChannel(c)}>{c === 'all' ? 'All channels' : CHANNEL_LABELS[c]}</button>)}
        <span className="dotsep">|</span>
        {(['all', 'delivered', 'retrying', 'failed', 'suppressed'] as const).map((st) => <button key={st} className={`chip ${status === st ? 'on' : ''}`} onClick={() => setStatus(st)} style={{ textTransform: 'capitalize' }}>{st === 'all' ? 'Any status' : st}</button>)}
      </div>
      <div className="panel" style={{ overflow: 'auto' }}>
        <table className="tbl" style={{ minWidth: 960 }}>
          <thead><tr><th>Time</th><th>Event</th><th>Rule</th><th>Channel</th><th>To</th><th>Status</th><th>Detail</th><th style={{ textAlign: 'right' }}>Latency</th><th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="t3" title={dateTimeIST(d.at)}>{ago(d.at)}</td>
                <td>{NOTIFY_EVENTS[d.event]?.label ?? d.event}</td>
                <td className="t2">{d.rule} <span className="mono t3">v{d.ruleVersion}</span></td>
                <td>{CHANNEL_LABELS[d.channel]}</td>
                <td className="mono t2" style={{ maxWidth: 160 }}>{d.recipient.startsWith('team:') ? 'team channel' : d.recipient.slice(0, 8)}</td>
                <td><span className={`st ${STATUS_CLASS[d.status]}`} style={{ textTransform: 'capitalize' }}>{d.status}{d.attempts > 1 ? ` · ${d.attempts} tries` : ''}</span></td>
                <td className="t3 trunc" style={{ maxWidth: 280 }} title={d.detail ?? ''}>{d.detail}</td>
                <td className="num t3" style={{ textAlign: 'right' }}>{d.latencyMs !== null ? `${d.latencyMs} ms` : ''}</td>
                <td>{(d.status === 'failed' || d.status === 'delivered') && <button className="btn sm ghost" onClick={() => resend(d.id)}>Resend</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty t3" style={{ padding: 32 }}>{log.isLoading ? 'Loading…' : 'Nothing sent yet with these filters.'}</div>}
      </div>
    </div>
  );
}

// ---------- channels ----------

const TARGET_HELP: Record<Channel, string> = {
  inapp: 'Always available: appears in the bell.',
  email: 'Optional From address. Uses the configured mail server (SES in AWS, Mailpit locally).',
  slack: 'Slack incoming webhook URL (https://hooks.slack.com/services/…). Locally: http://localhost:8091/slack/qa-alerts',
  teams: 'Teams Workflows webhook URL (Power Automate "post to a channel when a webhook request is received"). Locally: http://localhost:8091/teams/qa',
  discord: 'Discord channel webhook URL (https://discord.com/api/webhooks/…). Locally: http://localhost:8091/discord/releases',
  sms: 'On-call numbers in international format, comma-separated, e.g. +919876543210.',
};

function Channels({ base }: { base: string }) {
  const channels = useQuery({ queryKey: ['notify-channels', base], queryFn: () => get<ChannelConfig[]>(`${base}/channels`) });
  return (
    <div className={s.channels}>
      {channels.data?.map((c) => <ChannelCard key={c.channel} base={base} config={c} />)}
      {channels.error && <div className="empty t3">{channels.error instanceof ApiError ? channels.error.message : 'Could not load channels.'}</div>}
    </div>
  );
}

function ChannelCard({ base, config }: { base: string; config: ChannelConfig }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const needsTarget = (TEAM_CHANNELS as readonly string[]).includes(config.channel);

  const save = async (enabled: boolean) => {
    setError(null);
    try {
      await api('PUT', `${base}/channels/${config.channel}`, { enabled, ...(target.trim() && { target: target.trim() }) });
      await queryClient.invalidateQueries({ queryKey: ['notify-channels', base] });
      setTarget('');
      notify(`${CHANNEL_LABELS[config.channel]} ${enabled ? 'saved' : 'turned off'}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const test = async () => {
    await api('POST', `${base}/channels/${config.channel}/test`);
    notify(`Test message queued for ${CHANNEL_LABELS[config.channel]}; see the delivery log`);
  };

  return (
    <div className="panel col" style={{ padding: 14, gap: 10 }}>
      <div className="row">
        <b>{CHANNEL_LABELS[config.channel]}</b>
        <span className={`st ${config.enabled && config.configured ? 'st-passed' : 'st-untested'}`}>{config.enabled && config.configured ? 'On' : config.configured ? 'Off' : 'Not set up'}</span>
        <div className="f1" />
        {config.configured && <button className="btn sm" onClick={test}>Send test</button>}
      </div>
      <div className="t3" style={{ fontSize: 12, lineHeight: 1.45 }}>{TARGET_HELP[config.channel]}</div>
      {config.targetHint && <div className="mono t2" style={{ fontSize: 11.5 }}>Current: {config.targetHint}</div>}
      {config.channel !== 'inapp' && (
        <input className="inp mono" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={`${CHANNEL_LABELS[config.channel]} destination`}
          placeholder={config.targetHint ? 'Enter a new value to replace it' : needsTarget ? 'Paste the webhook URL or numbers' : 'testbench@yourcompany.in'} />
      )}
      {error && <div className="err">{error}</div>}
      <div className="row">
        <button className="btn sm primary" onClick={() => save(true)} disabled={needsTarget && !config.configured && !target.trim()}>{config.enabled ? 'Save' : 'Turn on'}</button>
        {config.enabled && config.channel !== 'inapp' && <button className="btn sm" onClick={() => save(false)}>Turn off</button>}
      </div>
    </div>
  );
}

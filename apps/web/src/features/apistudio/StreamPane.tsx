'use client';

import type { ApiRequestDef, ApiStreamSettings, StreamEvent, StreamResult, STREAM_PROTOCOLS } from '@tb/contracts';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { prettyBody } from './model';
import s from './apistudio.module.css';

// WebSocket and Server-Sent Events requests (plan §2): what to send once connected, and the transcript.

export const PROTOCOL_LABEL: Record<(typeof STREAM_PROTOCOLS)[number], string> = { http: 'HTTP', ws: 'WebSocket', sse: 'SSE' };
export const DEFAULT_STREAM: ApiStreamSettings = { send: [], listenMs: 5000, maxMessages: 50 };

export function StreamSettingsEditor({ def, readOnly, onChange }: { def: ApiRequestDef; readOnly: boolean; onChange(next: ApiStreamSettings): void }) {
  const st = { ...DEFAULT_STREAM, ...def.stream };
  const socket = def.protocol === 'ws';
  const clamp = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || min)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
      <div className="t3" style={{ fontSize: 12.5 }}>
        {socket
          ? 'Connects, sends the messages below in order, then listens. Headers, auth, query parameters and variables work as for any request.'
          : 'Connects and listens for events. Headers, auth, query parameters and variables work as for any request; a body is sent if the method has one.'}
      </div>
      {socket && (
        <div className="field">
          <span className="flab">Messages to send, one per box</span>
          {st.send.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <textarea className={s.code} style={{ minHeight: 44, flex: 1 }} value={m} readOnly={readOnly} aria-label={`Message ${i + 1}`} onChange={(e) => onChange({ ...st, send: st.send.map((x, j) => (j === i ? e.target.value : x)) })} />
              {!readOnly && <button className="btn ghost sm" aria-label={`Remove message ${i + 1}`} onClick={() => onChange({ ...st, send: st.send.filter((_, j) => j !== i) })}><Icon name="x" size={12} /></button>}
            </div>
          ))}
          {!readOnly && <div><button className="btn sm" onClick={() => onChange({ ...st, send: [...st.send, '{"type":"subscribe"}'] })}><Icon name="plus" size={12} />Message</button></div>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label className="field"><span className="flab">Listen for (ms)</span><input className="inp" type="number" min={200} max={60000} value={st.listenMs} readOnly={readOnly} onChange={(e) => onChange({ ...st, listenMs: clamp(e.target.value, 200, 60_000) })} /></label>
        <label className="field"><span className="flab">Stop after this many messages</span><input className="inp" type="number" min={1} max={500} value={st.maxMessages} readOnly={readOnly} onChange={(e) => onChange({ ...st, maxMessages: clamp(e.target.value, 1, 500) })} /></label>
      </div>
      <div className="t3" style={{ fontSize: 12 }}>Checks read the incoming messages as a list: <span className="mono">$[0].type</span> is the first message’s type. Messages that are not JSON are plain text. Pre-request scripts run; post scripts do not.</div>
    </div>
  );
}

const ENDED: Record<StreamResult['endedBy'], string> = { server: 'the server closed it', time: 'the listening time ran out', messages: 'enough messages came in', error: 'it failed' };
const GLYPH: Record<StreamEvent['kind'], string> = { open: '●', out: '↑', in: '↓', close: '■', error: '!' };

export function StreamPane({ result, sending }: { result: StreamResult | null; sending: boolean }) {
  const [tab, setTab] = useState<'messages' | 'checks' | 'headers'>('messages');
  if (sending) return <div className={s.resp}><div className="empty t3" style={{ flex: 1 }}><span className="spin" />Connected, listening…</div></div>;
  if (!result)
    return (
      <div className={s.resp}>
        <div className="empty t3" style={{ flex: 1 }}>
          <Icon name="play" size={20} />
          <div>Send to connect and see the messages here.</div>
          <div style={{ fontSize: 12 }}>It listens for the time on the Stream tab, then disconnects.</div>
        </div>
      </div>
    );
  const incoming = result.events.filter((e) => e.kind === 'in').length;
  const passed = result.assertions.filter((a) => a.passed).length;
  return (
    <div className={s.resp}>
      <div className={s.respHead}>
        {result.status !== null ? <span className={`${s.status} ${s[`t-${result.status < 300 || result.status === 101 ? '2xx' : 'none'}`]}`}>{result.status}</span> : <span className={`${s.status} ${s['t-none']}`}>Not connected</span>}
        <span className="t2">{result.timings.totalMs} ms</span>
        <span className="t2">{incoming} message{incoming === 1 ? '' : 's'} in</span>
        {result.status !== null && !result.error && <span className="t3">ended: {ENDED[result.endedBy]}{result.closeCode !== null ? ` (${result.closeCode})` : ''}</span>}
        {result.assertions.length > 0 && <span className={passed === result.assertions.length ? s.pass : s.fail}>{passed}/{result.assertions.length} checks passed</span>}
        <div className="f1" />
        <div className="tabs" role="tablist" aria-label="Stream result">
          {(['messages', 'checks', 'headers'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{{ messages: 'Messages', checks: 'Checks', headers: 'Headers' }[t]}</button>)}
        </div>
      </div>
      {result.error && <div className={s.notice} role="alert"><Icon name="alert" size={14} />{result.error.message}</div>}
      {result.scriptErrors.map((e, i) => <div key={i} className={s.notice} role="alert"><Icon name="alert" size={14} />Script in the {e.source}: {e.message}</div>)}
      <div className={s.pane} style={{ flex: 1 }}>
        {tab === 'messages' && (
          result.events.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.events.map((e, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '54px 16px minmax(0, 1fr)', gap: 6, fontSize: 12.5, alignItems: 'start' }}>
                  <span className="t3 mono" style={{ fontSize: 11 }}>{e.t} ms</span>
                  <span style={{ color: e.kind === 'in' ? 'var(--passed)' : e.kind === 'error' ? 'var(--failed)' : 'var(--text3)' }} aria-label={e.kind}>{GLYPH[e.kind]}</span>
                  <div style={{ minWidth: 0 }}>
                    {e.kind === 'open' && <span className="t3">connected</span>}
                    {e.kind === 'close' && <span className="t3">closed {e.data}</span>}
                    {(e.kind === 'in' || e.kind === 'out' || e.kind === 'error') && (
                      <>
                        {(e.event || e.id) && <span className="t3" style={{ fontSize: 11 }}>{e.event}{e.id ? ` #${e.id}` : ''} </span>}
                        <pre className={s.pre} style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{prettyBody(e.data, null)}</pre>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {result.truncated && <div className="t3" style={{ fontSize: 12 }}>The transcript was cut short: it keeps the first 600 events and 64 KB of each.</div>}
            </div>
          ) : (
            <div className="t3">Nothing came through.</div>
          )
        )}
        {tab === 'checks' && (
          result.assertions.length ? result.assertions.map((a) => <div key={a.id} style={{ fontSize: 12.5 }}><span className={a.passed ? s.pass : s.fail}>{a.passed ? '✓' : '✗'}</span> {a.message}</div>) : <div className="t3">No checks on this request. Add some in its Checks tab.</div>
        )}
        {tab === 'headers' && (
          <>
            <b style={{ fontSize: 12.5 }}>Sent</b>
            {result.requestHeaders.map(([k, v], i) => <div key={i} className="mono" style={{ fontSize: 12 }}><span className="t2">{k}:</span> {v}</div>)}
            <b style={{ fontSize: 12.5, display: 'block', marginTop: 10 }}>Received</b>
            {result.responseHeaders.length ? result.responseHeaders.map(([k, v], i) => <div key={i} className="mono" style={{ fontSize: 12 }}><span className="t2">{k}:</span> {v}</div>) : <div className="t3">None.</div>}
          </>
        )}
      </div>
    </div>
  );
}

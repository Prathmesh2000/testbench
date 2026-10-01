'use client';

import type { ApiTimings, SendResult } from '@tb/contracts';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { bytes } from '@/lib/format';
import { prettyBody, statusTone } from './model';
import s from './apistudio.module.css';

type Tab = 'body' | 'headers' | 'tests' | 'security' | 'console' | 'timing' | 'request';

/** The last send: status line, then body, headers, test results, timing and what was actually sent. */
export function ResponsePane({ result, sending, onBug, onDetectAuth }: { result: SendResult | null; sending: boolean; onBug?: (r: SendResult) => void; onDetectAuth?: (r: SendResult) => void }) {
  const [tab, setTab] = useState<Tab>('body');
  const [raw, setRaw] = useState(false);

  if (sending) return <div className={s.resp}><div className="empty t3" style={{ flex: 1 }}><span className="spin" />Sending…</div></div>;
  if (!result) {
    return (
      <div className={s.resp}>
        <div className="empty t3" style={{ flex: 1 }}>
          <Icon name="play" size={20} />
          <div>Send the request to see the response here.</div>
          <div style={{ fontSize: 12 }}>Requests go out from the Testbench server, so there are no CORS limits.</div>
        </div>
      </div>
    );
  }

  const r = result.response;
  const passed = result.assertions.filter((a) => a.passed).length;
  const tone = statusTone(r?.status ?? null);
  const body = r ? (r.bodyEncoding === 'base64' ? null : raw ? r.body : prettyBody(r.body, r.contentType)) : null;

  return (
    <div className={s.resp}>
      <div className={s.respHead}>
        {r ? (
          <>
            <span className={`${s.status} ${s[`t-${tone}`]}`}>{r.status} {r.statusText}</span>
            <span className="t2">{result.timings.totalMs} ms</span>
            <span className="t2">{bytes(r.sizeBytes)}{r.truncated ? ' (cut)' : ''}</span>
          </>
        ) : (
          <span className={`${s.status} ${s['t-none']}`}>No response</span>
        )}
        {result.assertions.length > 0 && (
          <span className={passed === result.assertions.length ? s.pass : s.fail}>{passed}/{result.assertions.length} checks passed</span>
        )}
        {result.security.length > 0 && <span style={{ color: 'var(--blocked)' }} title="See the Security tab">{result.security.length} security note{result.security.length === 1 ? '' : 's'}</span>}
        {result.drift && (result.drift.issues.length ? <span className={s.fail} title="The response differs from the spec">{result.drift.issues.length} differences from the spec</span> : <span className={s.pass}>matches the spec</span>)}
        <div className="f1" />
        {onDetectAuth && r && r.status < 300 && (/token|login|signin|session|auth/i.test(result.url) || result.cookiesSet.length > 0) && (
          <button className="btn sm" onClick={() => onDetectAuth(result)} title="Read how this login hands out its credential and make an auth profile from it"><Icon name="shield" size={12} />Make auth profile</button>
        )}
        {onBug && (result.error || result.assertions.some((a) => !a.passed)) && (
          <button className="btn sm" onClick={() => onBug(result)} title="Log a Jira bug with this request and response (secrets stay masked)"><Icon name="bug" size={12} />Log bug</button>
        )}
        <div className="tabs" role="tablist" aria-label="Response">
          {(['body', 'headers', 'tests', 'security', 'console', 'timing', 'request'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {{ body: 'Body', headers: 'Headers', tests: 'Checks', security: 'Security', console: 'Console', timing: 'Timing', request: 'Sent' }[t]}
              {t === 'headers' && r && <span className="n">{r.headers.length}</span>}
              {t === 'tests' && result.assertions.length > 0 && <span className="n">{result.assertions.length}</span>}
              {t === 'security' && result.security.length > 0 && <span className="n">{result.security.length}</span>}
              {t === 'console' && result.logs.length + result.scriptErrors.length > 0 && <span className="n">{result.logs.length + result.scriptErrors.length}</span>}
            </button>
          ))}
        </div>
      </div>
      {result.login && (
        <div className={s.notice} style={{ background: 'var(--accent-soft)' }}>
          <Icon name="info" size={14} />
          <div>
            Logged in first ({{ no_session: 'no session yet', expired: 'the session had expired', unauthorized: 'the API answered 401 to the saved session' }[result.login.reason]}): the login answered {result.login.status ?? 'nothing'}.
            {result.login.error ? ` ${result.login.error}` : ''} It is in History.
          </div>
        </div>
      )}
      {result.error && (
        <div className={s.notice} role="alert"><Icon name="alert" size={14} /><div><b>{result.error.code}</b>: {result.error.message}</div></div>
      )}
      {result.scriptErrors.filter((e) => e.phase === 'post').map((e, i) => (
        <div key={i} className={s.notice} role="alert"><Icon name="alert" size={14} /><div>The after-response script in the {e.source} failed: {e.message}</div></div>
      ))}
      {result.unresolved.length > 0 && (
        <div className={s.notice}>
          <Icon name="info" size={14} />
          <div>Not defined anywhere, sent as written: {result.unresolved.map((u) => <span key={u} className="mono" style={{ marginRight: 6 }}>{`{{${u}}}`}</span>)}</div>
        </div>
      )}
      <div className={s.pane} role="tabpanel">
        {tab === 'body' && r && (
          <>
            {r.bodyEncoding === 'utf8' && (
              <div className="seg" style={{ marginBottom: 8 }} role="radiogroup" aria-label="Body view">
                <button role="radio" aria-checked={!raw} className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>Pretty</button>
                <button role="radio" aria-checked={raw} className={raw ? 'on' : ''} onClick={() => setRaw(true)}>Raw</button>
              </div>
            )}
            {body !== null ? (
              <pre className={s.pre}>{body || <span className="t3">Empty body</span>}</pre>
            ) : r.contentType?.startsWith('image/') ? (
              <img alt="Response image" style={{ maxWidth: '100%' }} src={`data:${r.contentType};base64,${r.body}`} />
            ) : (
              <div className="t3">Binary body ({r.contentType ?? 'unknown type'}, {bytes(r.sizeBytes)}).</div>
            )}
          </>
        )}
        {tab === 'headers' && r && <Pairs rows={r.headers} />}
        {tab === 'tests' && result.drift && (
          <div style={{ marginBottom: 12 }}>
            <b style={{ fontSize: 12.5 }}>Against the spec ({result.drift.operation}, v{result.drift.specVersion})</b>
            {result.drift.issues.length === 0 && <div className={s.pass} style={{ fontSize: 12.5 }}>The response matches the documented {result.drift.status} response.</div>}
            {result.drift.issues.map((d, i) => (
              <div key={i} className={s.result}>
                <span className={s.fail}><Icon name="alert" size={14} /></span>
                <span className="mono" style={{ minWidth: 140 }}>{d.path}</span>
                <span>{{ type: `is ${d.actual}, the spec says ${d.expected}`, missing: 'is missing; the spec says it is required', enum: `is ${d.actual}, not one of ${d.expected}`, extra: `(${d.actual}) is not in the spec`, status: `status ${d.actual} is not documented (documented: ${d.expected})` }[d.kind]}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'tests' && (
          result.assertions.length ? (
            result.assertions.map((a) => (
              <div key={a.id} className={s.result}>
                <span className={a.passed ? s.pass : s.fail}><Icon name={a.passed ? 'check' : 'x'} size={14} /></span>
                <span>{a.message}</span>
              </div>
            ))
          ) : (
            <div className="t3">No checks on this request. Add them in the Checks tab above.</div>
          )
        )}
        {tab === 'security' && (
          result.security.length ? (
            result.security.map((f) => (
              <div key={f.fingerprint} className={s.result} style={{ flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 8 }}><b style={{ color: f.severity === 'high' ? 'var(--failed)' : f.severity === 'medium' ? 'var(--blocked)' : 'var(--text3)', width: 56 }}>{f.severity}</b><span>{f.title}</span></div>
                <div className="t2" style={{ paddingLeft: 64, fontSize: 12 }}>{f.detail}</div>
                <div className="t3" style={{ paddingLeft: 64, fontSize: 11 }}>{f.owasp}</div>
              </div>
            ))
          ) : (
            <div className="t3">Nothing risky in this response: headers, cookies, errors and fields were checked. Run the security checks on a spec for probes that attack the API.</div>
          )
        )}
        {tab === 'console' && (
          result.logs.length || result.scriptErrors.length ? (
            <div className="mono" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {result.logs.map((l, i) => (
                <div key={i} className={l.level === 'error' ? s.fail : l.level === 'warn' ? 't2' : undefined} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  <span className="t3">{l.phase === 'pre' ? 'before' : 'after'} ›</span> {l.text}
                </div>
              ))}
              {result.scriptErrors.map((e, i) => <div key={`e${i}`} className={s.fail}><span className="t3">{e.phase === 'pre' ? 'before' : 'after'} ›</span> {e.source}: {e.message}</div>)}
            </div>
          ) : (
            <div className="t3">Output from <span className="mono">console.log</span> in scripts shows here, with secrets masked.</div>
          )
        )}
        {tab === 'timing' && <Timing t={result.timings} redirects={result.redirects} />}
        {tab === 'request' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="mono">{result.method} {result.url}</div>
            <Pairs rows={result.requestHeaders} />
            {(result.cookiesSent.length > 0 || result.cookiesSet.length > 0) && (
              <div className="t2" style={{ fontSize: 12.5 }}>
                {result.cookiesSent.length > 0 && <div>Cookies sent: <span className="mono">{result.cookiesSent.join(', ')}</span></div>}
                {result.cookiesSet.length > 0 && <div>Cookies saved: <span className="mono">{result.cookiesSet.join(', ')}</span></div>}
              </div>
            )}
            {Object.keys(result.extracted).length > 0 && (
              <div className="t2" style={{ fontSize: 12.5 }}>Session values saved: {Object.entries(result.extracted).map(([k, v]) => <span key={k} className="mono" style={{ marginRight: 8 }}>{k} = {v.length > 40 ? `${v.slice(0, 40)}…` : v}</span>)}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Pairs({ rows }: { rows: [string, string][] }) {
  return (
    <table className={s.kv}>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i}>
            <td className="mono t2" style={{ width: '30%', verticalAlign: 'top' }}>{k}</td>
            <td className="mono" style={{ wordBreak: 'break-all' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Timing({ t, redirects }: { t: ApiTimings; redirects: SendResult['redirects'] }) {
  const total = Math.max(t.totalMs, 1);
  const phases: [string, number | null, number | null][] = [
    ['DNS lookup', 0, t.dnsMs],
    ['Connect', t.dnsMs ?? 0, t.connectMs],
    ['TLS', t.connectMs ?? 0, t.tlsMs],
    ['First byte', t.tlsMs ?? t.connectMs ?? 0, t.firstByteMs],
    ['Download', t.firstByteMs ?? 0, t.totalMs],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className={s.timing}>
        {phases.map(([label, from, to]) => (
          <div key={label} style={{ display: 'contents' }}>
            <span className="t2">{label}</span>
            <div className={s.timingBar}>
              {to !== null && <div className={s.timingFill} style={{ left: `${((from ?? 0) / total) * 100}%`, width: `${Math.max(0.5, ((to - (from ?? 0)) / total) * 100)}%` }} />}
            </div>
            <span className="mono t2">{to === null ? '—' : `${Math.max(0, to - (from ?? 0))} ms`}</span>
          </div>
        ))}
      </div>
      <div className="t3" style={{ fontSize: 12 }}>A reused connection has no DNS, connect or TLS time.</div>
      {redirects.length > 0 && (
        <div style={{ fontSize: 12.5 }}>
          <b>Redirects</b>
          {redirects.map((r, i) => <div key={i} className="mono t2">{r.status} → {r.url}</div>)}
        </div>
      )}
    </div>
  );
}

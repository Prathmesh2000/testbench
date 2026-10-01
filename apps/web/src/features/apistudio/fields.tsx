'use client';

import {
  ASSERT_OPS,
  ASSERT_SOURCES,
  type ApiAssertion,
  type ApiAuth,
  type ApiBody,
  type ApiExtractor,
  type ApiVariable,
  type KeyValue,
} from '@tb/contracts';
import { Icon } from '@/components/Icon';
import { newId } from './model';
import s from './apistudio.module.css';

// Editors shared by requests, folders and environments. Each is controlled: value in, onChange out.

/** Rows of key/value pairs with an on/off box, and a blank row at the end to type a new one into. */
export function KeyValueTable({ rows, onChange, readOnly, keyLabel = 'Key', valueLabel = 'Value' }: { rows: KeyValue[]; onChange(rows: KeyValue[]): void; readOnly?: boolean; keyLabel?: string; valueLabel?: string }) {
  const all = readOnly ? rows : [...rows, { key: '', value: '', enabled: true }];
  const set = (i: number, patch: Partial<KeyValue>) => {
    const next = all.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next.filter((r, j) => j < rows.length || r.key || r.value));
  };
  return (
    <table className={s.kv}>
      <tbody>
        {all.map((r, i) => (
          <tr key={i}>
            <td>{i < rows.length && <input type="checkbox" checked={r.enabled} disabled={readOnly} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label={`Use ${r.key || 'row'}`} />}</td>
            <td><input className={`inp ${s.cellMono}`} value={r.key} placeholder={keyLabel} aria-label={keyLabel} readOnly={readOnly} onChange={(e) => set(i, { key: e.target.value })} /></td>
            <td><input className={`inp ${s.cellMono}`} value={r.value} placeholder={valueLabel} aria-label={valueLabel} readOnly={readOnly} onChange={(e) => set(i, { value: e.target.value })} /></td>
            <td style={{ width: 28 }}>
              {!readOnly && i < rows.length && (
                <button className="btn ghost sm" aria-label={`Remove ${r.key || 'row'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Variables, where a row can be secret. A stored secret comes back empty with hasValue set; leaving it
 * empty keeps it, typing replaces it. The value is never shown again once saved.
 */
export function VariableTable({ rows, onChange, readOnly }: { rows: ApiVariable[]; onChange(rows: ApiVariable[]): void; readOnly?: boolean }) {
  const all: ApiVariable[] = readOnly ? rows : [...rows, { key: '', value: '', secret: false, enabled: true }];
  const set = (i: number, patch: Partial<ApiVariable>) => {
    const next = all.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next.filter((r, j) => j < rows.length || r.key || r.value));
  };
  return (
    <table className={s.kv}>
      <tbody>
        {all.map((r, i) => (
          <tr key={i}>
            <td>{i < rows.length && <input type="checkbox" checked={r.enabled} disabled={readOnly} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label={`Use ${r.key}`} />}</td>
            <td><input className={`inp ${s.cellMono}`} value={r.key} placeholder="name" aria-label="Variable name" readOnly={readOnly} onChange={(e) => set(i, { key: e.target.value })} /></td>
            <td>
              <input
                className={`inp ${s.cellMono}`}
                type={r.secret ? 'password' : 'text'}
                autoComplete="off"
                value={r.value}
                placeholder={r.secret && r.hasValue ? 'Stored. Type to replace it' : 'value'}
                aria-label={`Value of ${r.key || 'new variable'}`}
                readOnly={readOnly}
                onChange={(e) => set(i, { value: e.target.value })}
              />
            </td>
            <td style={{ width: 84 }}>
              {i < rows.length && (
                <label className="t2" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}>
                  <input type="checkbox" checked={r.secret} disabled={readOnly || (r.secret && r.hasValue)} onChange={(e) => set(i, { secret: e.target.checked })} />
                  Secret
                </label>
              )}
            </td>
            <td style={{ width: 28 }}>
              {!readOnly && i < rows.length && (
                <button className="btn ghost sm" aria-label={`Remove ${r.key}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const AUTH_LABELS: Record<ApiAuth['type'], string> = { inherit: 'Inherit', none: 'No auth', bearer: 'Bearer token', basic: 'Basic', apikey: 'API key', profile: 'Auth profile (log in first)' };

export function AuthEditor({ auth, onChange, readOnly, allowInherit = true, profiles = [] }: { auth: ApiAuth; onChange(a: ApiAuth): void; readOnly?: boolean; allowInherit?: boolean; profiles?: { id: string; name: string }[] }) {
  const types = (Object.keys(AUTH_LABELS) as ApiAuth['type'][]).filter((t) => (allowInherit || t !== 'inherit') && (t !== 'profile' || profiles.length > 0 || auth.type === 'profile'));
  const pick = (type: ApiAuth['type']) => {
    if (type === 'bearer') onChange({ type, token: '' });
    else if (type === 'basic') onChange({ type, username: '', password: '' });
    else if (type === 'apikey') onChange({ type, key: 'X-API-Key', value: '', in: 'header' });
    else if (type === 'profile') onChange({ type, profileId: profiles[0]!.id });
    else onChange({ type });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
      <div className="field">
        <label htmlFor="auth-type">Type</label>
        <select id="auth-type" className="inp" value={auth.type} disabled={readOnly} onChange={(e) => pick(e.target.value as ApiAuth['type'])}>
          {types.map((t) => <option key={t} value={t}>{AUTH_LABELS[t]}</option>)}
        </select>
      </div>
      {auth.type === 'inherit' && <div className="t3" style={{ fontSize: 12.5 }}>Uses the auth of the folder or collection this sits in.</div>}
      {auth.type === 'profile' && (
        <div className="field">
          <label htmlFor="auth-profile">Profile</label>
          <select id="auth-profile" className="inp" value={auth.profileId} disabled={readOnly} onChange={(e) => onChange({ type: 'profile', profileId: e.target.value })}>
            {!profiles.some((p) => p.id === auth.profileId) && <option value={auth.profileId}>A deleted profile</option>}
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="t3" style={{ fontSize: 12 }}>Logs in with the profile’s request when you have no session yet or it expired, then sends this. Manage profiles in the workspace settings.</span>
        </div>
      )}
      {auth.type === 'bearer' && (
        <div className="field">
          <label htmlFor="auth-token">Token</label>
          <input id="auth-token" className={`inp ${s.cellMono}`} value={auth.token} readOnly={readOnly} placeholder="{{token}}" onChange={(e) => onChange({ ...auth, token: e.target.value })} />
        </div>
      )}
      {auth.type === 'basic' && (
        <>
          <div className="field">
            <label htmlFor="auth-user">Username</label>
            <input id="auth-user" className="inp" value={auth.username} readOnly={readOnly} onChange={(e) => onChange({ ...auth, username: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="auth-pass">Password</label>
            <input id="auth-pass" className="inp" type="password" autoComplete="off" value={auth.password} readOnly={readOnly} placeholder="{{password}}" onChange={(e) => onChange({ ...auth, password: e.target.value })} />
          </div>
        </>
      )}
      {auth.type === 'apikey' && (
        <>
          <div className="field">
            <label htmlFor="auth-key">Name</label>
            <input id="auth-key" className={`inp ${s.cellMono}`} value={auth.key} readOnly={readOnly} onChange={(e) => onChange({ ...auth, key: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="auth-val">Value</label>
            <input id="auth-val" className={`inp ${s.cellMono}`} value={auth.value} readOnly={readOnly} placeholder="{{apiKey}}" onChange={(e) => onChange({ ...auth, value: e.target.value })} />
          </div>
          <div className="seg" role="radiogroup" aria-label="Send the key in">
            {(['header', 'query'] as const).map((w) => (
              <button key={w} role="radio" aria-checked={auth.in === w} className={auth.in === w ? 'on' : ''} disabled={readOnly} onClick={() => onChange({ ...auth, in: w })}>{w === 'header' ? 'Header' : 'Query string'}</button>
            ))}
          </div>
        </>
      )}
      {auth.type !== 'none' && auth.type !== 'inherit' && auth.type !== 'profile' && (
        <div className="t3" style={{ fontSize: 12 }}>Keep credentials in a secret variable, like <span className="mono">{'{{token}}'}</span>. Secret values are masked in history and never shown again.</div>
      )}
    </div>
  );
}

const BODY_LABELS: Record<ApiBody['type'], string> = { none: 'None', json: 'JSON', text: 'Text', form: 'Form', graphql: 'GraphQL' };

export function BodyEditor({ body, onChange, readOnly }: { body: ApiBody; onChange(b: ApiBody): void; readOnly?: boolean }) {
  const pick = (type: ApiBody['type']) => {
    if (type === 'json') onChange({ type, text: body.type === 'text' ? body.text : '{\n  \n}' });
    else if (type === 'text') onChange({ type, text: body.type === 'json' ? body.text : '', contentType: 'text/plain' });
    else if (type === 'form') onChange({ type, fields: [] });
    else if (type === 'graphql') onChange({ type, query: 'query {\n  \n}', variables: '' });
    else onChange({ type });
  };
  const jsonError = body.type === 'json' && body.text.trim() && !/\{\{/.test(body.text) ? parseError(body.text) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="seg" role="radiogroup" aria-label="Body type">
        {(Object.keys(BODY_LABELS) as ApiBody['type'][]).map((t) => (
          <button key={t} role="radio" aria-checked={body.type === t} className={body.type === t ? 'on' : ''} disabled={readOnly} onClick={() => pick(t)}>{BODY_LABELS[t]}</button>
        ))}
      </div>
      {body.type === 'none' && <div className="t3" style={{ fontSize: 12.5 }}>This request sends no body.</div>}
      {(body.type === 'json' || body.type === 'text') && (
        <>
          {body.type === 'text' && (
            <input className={`inp ${s.cellMono}`} style={{ maxWidth: 320 }} value={body.contentType} aria-label="Content type" readOnly={readOnly} onChange={(e) => onChange({ ...body, contentType: e.target.value })} />
          )}
          <textarea className={s.code} spellCheck={false} value={body.text} aria-label="Body" readOnly={readOnly} onChange={(e) => onChange({ ...body, text: e.target.value })} />
          {jsonError && <div className="err">{jsonError}</div>}
        </>
      )}
      {body.type === 'form' && <KeyValueTable rows={body.fields} onChange={(fields) => onChange({ ...body, fields })} readOnly={readOnly} keyLabel="Field" />}
      {body.type === 'graphql' && (
        <>
          <textarea className={s.code} spellCheck={false} value={body.query} aria-label="GraphQL query" readOnly={readOnly} onChange={(e) => onChange({ ...body, query: e.target.value })} />
          <label className="flab" htmlFor="gql-vars">Variables (JSON)</label>
          <textarea id="gql-vars" className={s.code} style={{ minHeight: 80 }} spellCheck={false} value={body.variables} readOnly={readOnly} onChange={(e) => onChange({ ...body, variables: e.target.value })} />
        </>
      )}
    </div>
  );
}

function parseError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return `Not valid JSON: ${err instanceof Error ? err.message : ''}`;
  }
}

const SOURCE_LABELS: Record<ApiAssertion['source'], string> = { status: 'Status', time: 'Time (ms)', size: 'Size (bytes)', header: 'Header', body: 'Body' };
const OP_LABELS: Record<ApiAssertion['op'], string> = {
  eq: 'equals',
  ne: 'does not equal',
  lt: 'less than',
  lte: 'at most',
  gt: 'greater than',
  gte: 'at least',
  contains: 'contains',
  notContains: 'does not contain',
  matches: 'matches regex',
  exists: 'exists',
  notExists: 'does not exist',
  type: 'is of type',
  in: 'is one of',
};

export function AssertionsEditor({ rows, onChange, readOnly }: { rows: ApiAssertion[]; onChange(rows: ApiAssertion[]): void; readOnly?: boolean }) {
  const set = (i: number, patch: Partial<ApiAssertion>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((a, i) => {
        const needsPath = a.source === 'header' || a.source === 'body';
        const needsValue = a.op !== 'exists' && a.op !== 'notExists';
        return (
          <div key={a.id} className={s.assertRow}>
            <input type="checkbox" checked={a.enabled} disabled={readOnly} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label="Use this check" />
            <select className="inp" value={a.source} disabled={readOnly} aria-label="Check" onChange={(e) => set(i, { source: e.target.value as ApiAssertion['source'] })}>
              {ASSERT_SOURCES.map((x) => <option key={x} value={x}>{SOURCE_LABELS[x]}</option>)}
            </select>
            <input className={`inp ${s.cellMono}`} value={a.path} disabled={readOnly || !needsPath} aria-label="Header name or JSONPath" placeholder={a.source === 'header' ? 'Content-Type' : needsPath ? '$.data.id' : ''} onChange={(e) => set(i, { path: e.target.value })} />
            <select className="inp" value={a.op} disabled={readOnly} aria-label="Comparison" onChange={(e) => set(i, { op: e.target.value as ApiAssertion['op'] })}>
              {ASSERT_OPS.map((x) => <option key={x} value={x}>{OP_LABELS[x]}</option>)}
            </select>
            <input className={`inp ${s.cellMono}`} value={a.value} disabled={readOnly || !needsValue} aria-label="Expected" placeholder={a.op === 'type' ? 'string, number, array…' : a.op === 'in' ? '200, 201' : ''} onChange={(e) => set(i, { value: e.target.value })} />
            {!readOnly && <button className="btn ghost sm" aria-label="Remove check" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>}
          </div>
        );
      })}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="btn sm" onClick={() => onChange([...rows, { id: newId(), source: 'status', path: '', op: 'eq', value: '200', enabled: true }])}><Icon name="plus" size={12} />Status</button>
          <button className="btn sm" onClick={() => onChange([...rows, { id: newId(), source: 'body', path: '$.', op: 'exists', value: '', enabled: true }])}><Icon name="plus" size={12} />Body value</button>
          <button className="btn sm" onClick={() => onChange([...rows, { id: newId(), source: 'time', path: '', op: 'lt', value: '800', enabled: true }])}><Icon name="plus" size={12} />Response time</button>
        </div>
      )}
      <div className="t3" style={{ fontSize: 12, marginTop: 10 }}>
        Paths use JSONPath: <span className="mono">$.items[0].id</span>, <span className="mono">$.items[*].qty</span> (checks every item), <span className="mono">$..id</span>.
      </div>
    </div>
  );
}

export function ExtractorsEditor({ rows, onChange, readOnly }: { rows: ApiExtractor[]; onChange(rows: ApiExtractor[]): void; readOnly?: boolean }) {
  const set = (i: number, patch: Partial<ApiExtractor>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((x, i) => (
        <div key={i} className={s.extractRow}>
          <input type="checkbox" checked={x.enabled} disabled={readOnly} onChange={(e) => set(i, { enabled: e.target.checked })} aria-label="Use this extractor" />
          <input className={`inp ${s.cellMono}`} value={x.variable} placeholder="variable" aria-label="Save into variable" readOnly={readOnly} onChange={(e) => set(i, { variable: e.target.value })} />
          <select className="inp" value={x.source} disabled={readOnly} aria-label="From" onChange={(e) => set(i, { source: e.target.value as ApiExtractor['source'] })}>
            <option value="body">Body</option>
            <option value="header">Header</option>
            <option value="status">Status</option>
          </select>
          <input className={`inp ${s.cellMono}`} value={x.path} disabled={readOnly || x.source === 'status'} placeholder={x.source === 'header' ? 'Location' : '$.token'} aria-label="Path" onChange={(e) => set(i, { path: e.target.value })} />
          {!readOnly && <button className="btn ghost sm" aria-label="Remove extractor" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>}
        </div>
      ))}
      {!readOnly && (
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => onChange([...rows, { variable: '', source: 'body', path: '$.', enabled: true }])}><Icon name="plus" size={12} />Extract a value</button>
      )}
      <div className="t3" style={{ fontSize: 12, marginTop: 10 }}>
        Extracted values become session values for your later requests, like <span className="mono">{'{{token}}'}</span> after a login. They stay in your browser and never overwrite the team’s environments.
      </div>
    </div>
  );
}

const SNIPPETS: { phase: 'pre' | 'post'; label: string; code: string }[] = [
  { phase: 'pre', label: 'Set a variable', code: "tb.variables.set('requestId', tb.crypto.uuid());" },
  { phase: 'pre', label: 'Add a header', code: "tb.request.headers.upsert({ key: 'X-Request-Id', value: tb.crypto.uuid() });" },
  { phase: 'pre', label: 'Sign with HMAC', code: "const ts = String(Math.floor(Date.now() / 1000));\nconst sig = tb.crypto.hmacSha256(tb.variables.get('apiSecret'), ts + (tb.request.body.raw || ''));\ntb.request.headers.upsert({ key: 'X-Timestamp', value: ts });\ntb.request.headers.upsert({ key: 'X-Signature', value: sig });" },
  { phase: 'post', label: 'Check status', code: "tb.test('status is 200', () => tb.expect(tb.response.code).to.equal(200));" },
  { phase: 'post', label: 'Check a field', code: "tb.test('has an id', () => tb.expect(tb.response.json()).to.have.property('id'));" },
  { phase: 'post', label: 'Save the token', code: "tb.variables.set('token', tb.response.json().token);" },
];

/** Pre- and post-request JavaScript. Runs on the server in a sandbox; `pm.*` works as in Postman. */
export function ScriptsEditor({ scripts, onChange, readOnly, scope }: { scripts: { pre: string; post: string }; onChange(s: { pre: string; post: string }): void; readOnly?: boolean; scope: 'request' | 'folder' | 'collection' }) {
  const add = (phase: 'pre' | 'post', code: string) => onChange({ ...scripts, [phase]: scripts[phase] ? `${scripts[phase].trimEnd()}\n${code}` : code });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(['pre', 'post'] as const).map((phase) => (
        <div key={phase} className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <label htmlFor={`script-${phase}`}>{phase === 'pre' ? 'Before the request is sent' : 'After the response arrives'}</label>
            <div className="f1" />
            {!readOnly && SNIPPETS.filter((x) => x.phase === phase).map((x) => (
              <button key={x.label} className="btn ghost sm" onClick={() => add(phase, x.code)}><Icon name="plus" size={11} />{x.label}</button>
            ))}
          </div>
          <textarea
            id={`script-${phase}`}
            className={s.code}
            style={{ minHeight: 120 }}
            spellCheck={false}
            value={scripts[phase]}
            readOnly={readOnly}
            placeholder={phase === 'pre' ? "tb.variables.set('ts', Date.now());" : "tb.test('ok', () => tb.expect(tb.response.code).to.equal(200));"}
            onChange={(e) => onChange({ ...scripts, [phase]: e.target.value })}
          />
        </div>
      ))}
      <div className="t3" style={{ fontSize: 12, lineHeight: 1.6 }}>
        {scope === 'request'
          ? 'Collection and folder scripts run around this one: before-scripts from the collection inwards, after-scripts from the request outwards.'
          : `Runs for every request in this ${scope}.`}{' '}
        Available: <span className="mono">tb.variables</span>, <span className="mono">tb.request</span>, <span className="mono">tb.response</span>, <span className="mono">tb.test</span>, <span className="mono">tb.expect</span>, <span className="mono">tb.crypto</span>, <span className="mono">console.log</span>. Postman’s <span className="mono">pm.*</span> works too. Scripts run on the server with no network or files, 1 second at most; variables they set become your session values.
      </div>
    </div>
  );
}

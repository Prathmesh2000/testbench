'use client';

import type { ApiNode, ApiTarget, AuthProfileConfig, AuthProfileView, ClientCertView } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { dateTimeIST } from '@/lib/format';
import s from './apistudio.module.css';

// Workspace settings for auth profiles (log in once, reuse the session) and client certificates
// (plan §4, §16.5).

export const useProfiles = (base: string, workspaceId: string | undefined) =>
  useQuery({ queryKey: ['apitest', 'profiles', workspaceId], queryFn: () => get<AuthProfileView[]>(`${base}/profiles`), enabled: !!workspaceId });

const EMPTY: AuthProfileConfig = { extract: { source: 'body', path: '$.access_token' }, apply: { as: 'bearer' }, ttlSeconds: null, reloginOn401: true, csrf: null };

export function ProfilesPanel({ base, workspaceId, requests, canEdit }: { base: string; workspaceId: string; requests: ApiNode[]; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const profiles = useProfiles(base, workspaceId);
  const [editing, setEditing] = useState<AuthProfileView | 'new' | null>(null);
  const [name, setName] = useState('');
  const [loginNodeId, setLoginNodeId] = useState('');
  const [config, setConfig] = useState<AuthProfileConfig>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const open = (p: AuthProfileView | 'new') => {
    setEditing(p);
    setError(null);
    setName(p === 'new' ? '' : p.name);
    setLoginNodeId(p === 'new' ? (requests[0]?.id ?? '') : (p.loginNodeId ?? ''));
    setConfig(p === 'new' ? EMPTY : p.config);
  };
  const save = async () => {
    setError(null);
    try {
      const body = { name, loginNodeId, config };
      if (editing === 'new') await api('POST', `${base}/profiles`, body);
      else if (editing) await api('PUT', `${base}/profiles/${editing.id}`, body);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'profiles', workspaceId] });
      setEditing(null);
      notify('Saved. Everyone’s sessions for it were reset, so the next request logs in again.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const remove = async (p: AuthProfileView) => {
    if (!window.confirm(`Delete the auth profile "${p.name}"? Requests using it will fail until they use another.`)) return;
    await api('DELETE', `${base}/profiles/${p.id}`);
    queryClient.invalidateQueries({ queryKey: ['apitest', 'profiles', workspaceId] });
  };
  const forget = async () => {
    await api('DELETE', `${base}/sessions`);
    notify('Your sessions are cleared; the next request logs in again.');
  };

  if (editing)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field">
          <label htmlFor="prof-name">Name</label>
          <input id="prof-name" className="inp" value={name} placeholder="Admin user" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="prof-login">Login request</label>
          <select id="prof-login" className="inp" value={loginNodeId} onChange={(e) => setLoginNodeId(e.target.value)}>
            {requests.map((r) => <option key={r.id} value={r.id}>{r.method} {r.name}</option>)}
          </select>
          <span className="t3" style={{ fontSize: 12 }}>An ordinary request in this workspace that logs in: keep the password in a secret variable.</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
          <div className="field">
            <label htmlFor="prof-src">Credential is in the</label>
            <select id="prof-src" className="inp" value={config.extract.source} onChange={(e) => setConfig({ ...config, extract: { source: e.target.value as AuthProfileConfig['extract']['source'], path: e.target.value === 'body' ? '$.access_token' : e.target.value === 'cookie' ? 'sid' : 'X-Auth-Token' } })}>
              <option value="body">Response body</option>
              <option value="header">Response header</option>
              <option value="cookie">Cookie</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="prof-path">{config.extract.source === 'body' ? 'JSONPath' : config.extract.source === 'cookie' ? 'Cookie name' : 'Header name'}</label>
            <input id="prof-path" className="inp mono" value={config.extract.path} onChange={(e) => setConfig({ ...config, extract: { ...config.extract, path: e.target.value } })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="prof-apply">Send it as</label>
          <select id="prof-apply" className="inp" value={config.apply.as} onChange={(e) => setConfig({ ...config, apply: e.target.value === 'header' ? { as: 'header', header: 'X-Auth-Token', prefix: '' } : { as: e.target.value as 'bearer' | 'cookie' } })}>
            <option value="bearer">Authorization: Bearer …</option>
            <option value="header">A header of its own</option>
            <option value="cookie">The cookie itself (browser-style session)</option>
          </select>
        </div>
        {config.apply.as === 'header' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 8 }}>
            <input className="inp mono" aria-label="Header name" value={config.apply.header} onChange={(e) => setConfig({ ...config, apply: { ...(config.apply as { as: 'header'; header: string; prefix: string }), header: e.target.value } })} />
            <input className="inp mono" aria-label="Prefix" placeholder="prefix, e.g. Token " value={config.apply.prefix} onChange={(e) => setConfig({ ...config, apply: { ...(config.apply as { as: 'header'; header: string; prefix: string }), prefix: e.target.value } })} />
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="field">
            <label htmlFor="prof-ttl">Session lasts (seconds)</label>
            <input id="prof-ttl" className="inp" type="number" min={10} placeholder="From the token, or until a 401" value={config.ttlSeconds ?? ''} onChange={(e) => setConfig({ ...config, ttlSeconds: e.target.value ? Number(e.target.value) : null })} />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, marginTop: 18 }}>
            <input type="checkbox" checked={config.reloginOn401} onChange={(e) => setConfig({ ...config, reloginOn401: e.target.checked })} />
            Log in again once on a 401
          </label>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
          <input type="checkbox" checked={config.csrf !== null} onChange={(e) => setConfig({ ...config, csrf: e.target.checked ? { cookie: 'XSRF-TOKEN', header: 'X-XSRF-TOKEN' } : null })} />
          Send a CSRF header on POST, PUT, PATCH and DELETE, copied from a cookie
        </label>
        {config.csrf && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input className="inp mono" aria-label="CSRF cookie" value={config.csrf.cookie} onChange={(e) => setConfig({ ...config, csrf: { ...config.csrf!, cookie: e.target.value } })} />
            <input className="inp mono" aria-label="CSRF header" value={config.csrf.header} onChange={(e) => setConfig({ ...config, csrf: { ...config.csrf!, header: e.target.value } })} />
          </div>
        )}
        {error && <div className="err" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" disabled={!name.trim() || !loginNodeId} onClick={save}>Save profile</button>
          <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="t3" style={{ fontSize: 12.5 }}>
        A profile logs in with a request from this workspace, keeps the session for you (encrypted, per environment), and logs in again when it expires or the API answers 401. Pick it in any request’s, folder’s or collection’s Auth tab.
      </div>
      {profiles.data?.map((p) => (
        <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--soft)' }}>
          <b>{p.name}</b>
          <span className="t2 trunc">logs in with {p.loginName ?? <span className={s.fail}>a deleted request</span>} · {p.config.apply.as === 'bearer' ? 'Bearer token' : p.config.apply.as === 'cookie' ? 'cookie session' : p.config.apply.header}{p.config.csrf ? ' · CSRF' : ''}</span>
          <div className="f1" />
          {canEdit && <button className="btn sm" onClick={() => open(p)}>Edit</button>}
          {canEdit && <button className="btn ghost sm" aria-label={`Delete ${p.name}`} onClick={() => remove(p)}><Icon name="x" size={12} /></button>}
        </div>
      ))}
      {profiles.data?.length === 0 && <div className="t3" style={{ fontSize: 12.5 }}>No auth profiles yet.</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        {canEdit && <button className="btn" disabled={!requests.length} title={requests.length ? undefined : 'Make the login request first'} onClick={() => open('new')}><Icon name="plus" size={12} />New profile</button>}
        {(profiles.data?.length ?? 0) > 0 && <button className="btn ghost" onClick={forget}>Log me out everywhere</button>}
      </div>
    </div>
  );
}

export function CertsPanel({ base, workspaceId, canEdit }: { base: string; workspaceId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const certs = useQuery({ queryKey: ['apitest', 'certs', workspaceId], queryFn: () => get<ClientCertView[]>(`${base}/certificates`) });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', cert: '', key: '', passphrase: '', ca: '' });
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim()));
      await api('POST', `${base}/certificates`, body);
      queryClient.invalidateQueries({ queryKey: ['apitest', 'certs', workspaceId] });
      setAdding(false);
      setForm({ name: '', host: '', cert: '', key: '', passphrase: '', ca: '' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const remove = async (c: ClientCertView) => {
    if (!window.confirm(`Delete the certificate for ${c.host}?`)) return;
    await api('DELETE', `${base}/certificates/${c.id}`);
    queryClient.invalidateQueries({ queryKey: ['apitest', 'certs', workspaceId] });
  };
  const field = (k: keyof typeof form, label: string, area = false) => (
    <div className="field">
      <label htmlFor={`cert-${k}`}>{label}</label>
      {area ? (
        <textarea id={`cert-${k}`} className={s.code} style={{ minHeight: 70 }} spellCheck={false} value={form[k]} placeholder="-----BEGIN …" onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
      ) : (
        <input id={`cert-${k}`} className="inp" type={k === 'passphrase' ? 'password' : 'text'} autoComplete="off" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
      )}
    </div>
  );

  if (adding)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {field('name', 'Name')}
          {field('host', 'Host (api.bank.test, *.bank.test, :8443)')}
        </div>
        {field('cert', 'Client certificate (PEM)', true)}
        {field('key', 'Private key (PEM)', true)}
        {field('passphrase', 'Key passphrase, if it has one')}
        {field('ca', 'CA certificate, for a server with a private certificate (optional)', true)}
        {error && <div className="err" role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={save} disabled={!form.name.trim() || !form.host.trim()}>Save certificate</button>
          <button className="btn" onClick={() => setAdding(false)}>Cancel</button>
        </div>
      </div>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="t3" style={{ fontSize: 12.5 }}>
        Sent to APIs that ask for a client certificate (mutual TLS). The most specific host wins. Stored encrypted; the private key is never shown again. A CA alone lets you call a test server whose certificate your company issued, without turning checks off.
      </div>
      {certs.data?.map((c) => {
        const soon = c.expiresAt && new Date(c.expiresAt).getTime() - Date.now() < 14 * 86_400_000;
        return (
          <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--soft)' }}>
            <b className="mono">{c.host}</b>
            <span className="t2 trunc">{c.name} · {c.subject}{c.hasClientCert ? '' : ' · CA only'}{c.hasCa && c.hasClientCert ? ' · with CA' : ''}</span>
            {c.expiresAt && <span className={soon ? s.fail : 't3'}>until {dateTimeIST(c.expiresAt)}</span>}
            <div className="f1" />
            {canEdit && <button className="btn ghost sm" aria-label={`Delete certificate for ${c.host}`} onClick={() => remove(c)}><Icon name="x" size={12} /></button>}
          </div>
        );
      })}
      {certs.data?.length === 0 && <div className="t3" style={{ fontSize: 12.5 }}>No certificates yet.</div>}
      {canEdit && <div><button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={12} />Add certificate</button></div>}
    </div>
  );
}

/** Hosts the project has proved are its own: load tests and attack probes go only to these (plan §14). */
export function TargetsPanel({ projectBase, canEdit }: { projectBase: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const targets = useQuery({ queryKey: ['apitest', 'targets', projectBase], queryFn: () => get<ApiTarget[]>(`${projectBase}/targets`) });
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['apitest', 'targets', projectBase] });

  const add = async () => {
    setError(null);
    try {
      await api('POST', `${projectBase}/targets`, { host: host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') });
      setHost('');
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add it');
    }
  };
  const verify = async (t: ApiTarget, method: 'dns' | 'file') => {
    setBusy(`${t.id}${method}`);
    try {
      await api('POST', `${projectBase}/targets/${t.id}/verify`, { method });
      notify(`${t.host} is verified`);
      refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not verify it', 'bad');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (t: ApiTarget) => {
    if (!window.confirm(`Remove ${t.host}? Load tests and security checks against it stop until it is verified again.`)) return;
    await api('DELETE', `${projectBase}/targets/${t.id}`);
    refresh();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="t3" style={{ fontSize: 12.5 }}>
        Load tests and attack probes go only to hosts you have proved are yours, so Testbench cannot be used against someone else’s site. Add the host, publish one of the two proofs, then verify. Hosts on your own machine during local development need no proof.
      </div>
      {targets.data?.map((t) => (
        <div key={t.id} className={s.card} style={{ border: '1px solid var(--soft)', borderRadius: 'var(--r-sm)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b className="mono">{t.host}</b>
            <span className="lbl" style={{ color: t.status === 'verified' ? 'var(--passed)' : 'var(--blocked)' }}>{t.status === 'verified' ? `verified by ${t.method}` : 'not verified'}</span>
            <div className="f1" />
            {canEdit && <button className="btn ghost sm" aria-label={`Remove ${t.host}`} onClick={() => remove(t)}><Icon name="x" size={12} /></button>}
          </div>
          {t.status === 'pending' && (
            <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><b>Either</b> add a DNS TXT record named <span className="mono">{t.challenge.dns.name}</span> with the value <span className="mono">{t.challenge.dns.value}</span> {canEdit && <button className="btn sm" disabled={busy !== null} onClick={() => verify(t, 'dns')}>{busy === `${t.id}dns` ? 'Checking…' : 'Verify DNS'}</button>}</div>
              <div><b>or</b> serve the text <span className="mono">{t.challenge.file.content}</span> at <span className="mono">{t.challenge.file.url}</span> {canEdit && <button className="btn sm" disabled={busy !== null} onClick={() => verify(t, 'file')}>{busy === `${t.id}file` ? 'Checking…' : 'Verify file'}</button>}</div>
            </div>
          )}
        </div>
      ))}
      {targets.data?.length === 0 && <div className="t3" style={{ fontSize: 12.5 }}>No hosts yet.</div>}
      {canEdit && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="inp mono" style={{ flex: 1 }} value={host} placeholder="staging.example.com" aria-label="Host to add" onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && host.trim() && add()} />
          <button className="btn" disabled={!host.trim()} onClick={add}><Icon name="plus" size={12} />Add host</button>
        </div>
      )}
      {error && <div className="err" role="alert">{error}</div>}
    </div>
  );
}

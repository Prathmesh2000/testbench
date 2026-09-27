'use client';

import type { TokenCreated, TokenView } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, dateTimeIST } from '@/lib/format';
import s from './admin.module.css';

const MCP_URL = 'http://localhost:4200/mcp';
const MCP_TOOLS = ['list_projects', 'search_tests', 'get_test_case', 'create_test_cases', 'create_run', 'get_run_status', 'log_bug', 'get_prd', 'get_traceability'];
const EXPIRY_DAYS = [7, 30, 90, 365];

/** Copies text and confirms with a toast. Clipboard access can be refused (non-secure origin, permissions). */
export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what: string }) {
  const { notify } = useToast();
  const copy = () => navigator.clipboard.writeText(text).then(
    () => notify(`${what} copied`),
    () => notify('Could not copy; select the text and copy it instead', 'bad'),
  );
  return <button type="button" className="btn sm" onClick={copy} aria-label={`Copy ${what.toLowerCase()}`}>{label}</button>;
}

/** Personal access tokens for the API, MCP clients and the Slack bot, plus how to connect each. */
export function AccessTokens() {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: ['me-tokens'], queryFn: () => get<TokenView[]>('/me/tokens') });
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['me-tokens'] });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const token = await api<TokenCreated>('POST', '/me/tokens', { name: name.trim(), scopes: write ? ['read', 'write'] : ['read'], days });
      setCreated(token);
      setName('');
      await refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the token', 'bad');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api('DELETE', `/me/tokens/${id}`);
      if (created?.id === id) setCreated(null);
      setConfirmId(null);
      await refresh();
      notify('Token revoked');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not revoke the token', 'bad');
    }
  };

  const token = created?.token ?? 'tbp_…';
  const mcpCommand = `claude mcp add --transport http testbench ${MCP_URL} --header "Authorization: Bearer ${token}"`;
  const live = tokens.data?.filter((t) => !t.revoked) ?? [];

  return (
    <section className="panel">
      <div className="hdr"><h3>Access tokens</h3>{tokens.data && <span className="cnt">{live.length}</span>}<div className="f1" /><span className="t3" style={{ fontSize: 11.5 }}>For the API, AI agents (MCP) and the Slack bot. They act as you.</span></div>
      <div className={s.tokens}>
        <form className={s.form} onSubmit={create}>
          <div className="field f1" style={{ minWidth: 180 }}>
            <label htmlFor="tok-name">Name</label>
            <input id="tok-name" className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on my laptop" maxLength={80} />
          </div>
          <div className="field">
            <span className="flab">Scopes</span>
            <div className="seg" role="radiogroup" aria-label="Scopes">
              <button type="button" role="radio" aria-checked={!write} className={!write ? 'on' : ''} onClick={() => setWrite(false)}>Read</button>
              <button type="button" role="radio" aria-checked={write} className={write ? 'on' : ''} onClick={() => setWrite(true)}>Read + write</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="tok-days">Expires in</label>
            <select id="tok-days" className="inp" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
          <button type="submit" className="btn primary" disabled={saving || !name.trim()}>{saving ? 'Creating…' : 'Create token'}</button>
        </form>

        {created && (
          <div className="banner warn" role="alert" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="row"><Icon name="alert" /><b style={{ fontWeight: 500 }}>Copy {created.name} now. It won’t be shown again.</b><div className="f1" /><button type="button" className="btn ghost sm" onClick={() => setCreated(null)}>Done</button></div>
            <div className={s.secret}><code className="mono">{created.token}</code><CopyButton text={created.token} what="Token" /></div>
          </div>
        )}

        {tokens.error && <div className="empty t3">{tokens.error instanceof ApiError ? tokens.error.message : 'Tokens are not available.'}</div>}
        {tokens.data && (tokens.data.length === 0 ? (
          <div className="t3" style={{ fontSize: 12.5 }}>No tokens yet.</div>
        ) : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Token</th><th>Scopes</th><th>Expires</th><th>Last used</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {tokens.data.map((t) => {
                const expired = new Date(t.expiresAt).getTime() < Date.now();
                return (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="mono t2">{t.prefix}…</td>
                    <td className="t2">{t.scopes.join(' + ')}</td>
                    <td className={expired || t.revoked ? 'st-failed' : 't2'}>{t.revoked ? 'Revoked' : expired ? 'Expired' : dateTimeIST(t.expiresAt)}</td>
                    <td className="t3">{t.lastUsedAt ? ago(t.lastUsedAt) : 'Never'}</td>
                    <td className={s.actions}>
                      {!t.revoked && (confirmId === t.id ? (
                        <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <span className="t2" style={{ fontSize: 12 }}>Revoke?</span>
                          <button type="button" className="btn sm danger" onClick={() => revoke(t.id)}>Revoke</button>
                          <button type="button" className="btn sm" onClick={() => setConfirmId(null)}>Keep</button>
                        </span>
                      ) : (
                        <button type="button" className="btn ghost sm danger" onClick={() => setConfirmId(t.id)} aria-label={`Revoke ${t.name}`}>Revoke</button>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}

        <div className={s.block}>
          <div className="sec">Connect an AI agent (MCP)</div>
          <p className="t2">Run this once in a terminal to give Claude Code the Testbench tools{created ? '' : '; replace tbp_… with your token'}.</p>
          <div className={s.cmd}><code className="mono">{mcpCommand}</code><CopyButton text={mcpCommand} what="Command" /></div>
          <div className={s.tools} aria-label="Tools the agent gets">{MCP_TOOLS.map((t) => <span key={t} className="lbl mono">{t}</span>)}</div>
        </div>

        <div className={s.block}>
          <div className="sec">Slack</div>
          <p className="t2">
            Type <code className="mono">/tcm login &lt;token&gt;</code> in Slack once; then <code className="mono">/tcm status RUN-12 PAY</code>, <code className="mono">/tcm run smoke PAY 8812</code>.
            {' '}Locally, try it at <a href="http://localhost:8091/slack-console" target="_blank" rel="noreferrer">http://localhost:8091/slack-console</a>.
          </p>
        </div>
      </div>
    </section>
  );
}

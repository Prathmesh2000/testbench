'use client';

import type { JiraConnection, JiraMapping, JiraProjectOption } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { dateTimeIST } from '@/lib/format';

const TOKEN_HELP = 'https://id.atlassian.com/manage-profile/security/api-tokens';

/**
 * The tester's own Jira connection. Bugs, comments and retest results they send from Testbench show
 * as them in Jira; the token is stored encrypted and never shown again.
 */
export function JiraSettings() {
  const { me, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const conn = useQuery({ queryKey: ['me-jira'], queryFn: () => get<JiraConnection | null>('/me/jira'), retry: false });
  const [editing, setEditing] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState(me.user.email);
  const [apiToken, setApiToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = conn.data;
  const showForm = editing || (!conn.isLoading && !connected);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api<JiraConnection>('PUT', '/me/jira', { siteUrl: siteUrl.trim(), email: email.trim(), apiToken: apiToken.trim() });
      setApiToken('');
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['me-jira'] });
      await queryClient.invalidateQueries({ queryKey: ['defect-sync'] });
      notify('Jira connected. Bugs you log now show your name in Jira');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Jira');
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    try {
      await api('DELETE', '/me/jira');
      await queryClient.invalidateQueries({ queryKey: ['me-jira'] });
      notify('Jira disconnected');
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not disconnect', 'bad');
    }
  };

  return (
    <section className="panel" id="jira">
      <div className="hdr">
        <h3>Jira</h3>
        <div className="f1" />
        <span className="t3" style={{ fontSize: 11.5 }}>Your own account: bugs you log show your name in Jira</span>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {connected && !editing && (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span className={`dot ${connected.status === 'active' ? 'ok' : 'bad'}`} />
            <div className="col f1" style={{ gap: 2 }}>
              <b>{connected.displayName} <span className="t3" style={{ fontWeight: 400 }}>· {connected.email}</span></b>
              <span className="t3" style={{ fontSize: 12 }}>
                {connected.siteUrl} · connected {dateTimeIST(connected.connectedAt)}
              </span>
              {connected.status === 'error' && (
                <span className="err">Jira stopped accepting your token{connected.lastError ? `: ${connected.lastError}` : ''}. Reconnect with a new one.</span>
              )}
            </div>
            <button className="btn" onClick={() => { setSiteUrl(connected.siteUrl); setEmail(connected.email); setEditing(true); }}>
              {connected.status === 'error' ? 'Reconnect' : 'Change'}
            </button>
            <button className="btn" onClick={disconnect}>Disconnect</button>
          </div>
        )}

        {showForm && (
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <div className="field">
                <label htmlFor="jira-site">Jira site</label>
                <input id="jira-site" className="inp" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://your-team.atlassian.net" required />
              </div>
              <div className="field">
                <label htmlFor="jira-email">Atlassian email</label>
                <input id="jira-email" className="inp" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="jira-token">API token</label>
                <input id="jira-token" className="inp" type="password" autoComplete="off" value={apiToken} onChange={(e) => setApiToken(e.target.value)} required minLength={8} />
              </div>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={saving}>{saving ? 'Checking with Jira…' : 'Connect Jira'}</button>
              {editing && <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>}
              <a className="t3" style={{ fontSize: 12 }} href={TOKEN_HELP} target="_blank" rel="noreferrer">
                <Icon name="link" size={11} /> Create an API token in your Atlassian account
              </a>
              {error && <span className="err">{error}</span>}
            </div>
          </form>
        )}
      </div>
      {can('project.manage') && <JiraProjectMapping connected={!!connected && connected.status === 'active'} site={connected?.siteUrl ?? null} />}
    </section>
  );
}

/** Where this project's bugs go in Jira. Checked against Jira through the admin's own connection. */
function JiraProjectMapping({ connected, site }: { connected: boolean; site: string | null }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const mapping = useQuery({ queryKey: ['jira-mapping', project.id], queryFn: () => get<JiraMapping | null>(`/projects/${project.id}/jira/mapping`) });
  const options = useQuery({ queryKey: ['jira-projects', site], queryFn: () => get<JiraProjectOption[]>('/me/jira/projects'), enabled: connected, retry: false });
  const [jiraKey, setJiraKey] = useState('');
  const [issueType, setIssueType] = useState('Bug');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mapping.data) {
      setJiraKey(mapping.data.jiraKey);
      setIssueType(mapping.data.issueType);
    }
  }, [mapping.data]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api<JiraMapping>('PUT', `/projects/${project.id}/jira/mapping`, { siteUrl: site, jiraKey, issueType });
      await queryClient.invalidateQueries({ queryKey: ['jira-mapping', project.id] });
      notify(`${project.key} now files bugs in ${jiraKey}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the mapping', 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '12px 14px 14px', borderTop: '1px solid var(--soft)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <b style={{ fontSize: 12.5 }}>Where {project.key} files bugs</b>
        <span className="t3" style={{ fontSize: 12 }}>
          {mapping.data
            ? `${mapping.data.siteUrl} · ${mapping.data.jiraKey} · ${mapping.data.issueType}`
            : `Not mapped: bugs go to Jira project ${project.key} on each tester's own site`}
        </span>
      </div>
      {connected ? (
        <form onSubmit={save} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="jira-map-key">Jira project</label>
            <select id="jira-map-key" className="inp" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} required>
              <option value="" disabled>Choose…</option>
              {options.data?.map((p) => <option key={p.key} value={p.key}>{p.key} · {p.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="jira-map-type">Issue type</label>
            <input id="jira-map-type" className="inp" value={issueType} onChange={(e) => setIssueType(e.target.value)} required />
          </div>
          <button className="btn" disabled={saving || !jiraKey}>{saving ? 'Checking…' : 'Save mapping'}</button>
          <span className="t3" style={{ fontSize: 12 }}>Testers must connect to {site}</span>
        </form>
      ) : (
        <span className="t3" style={{ fontSize: 12 }}>Connect your own Jira above to choose a project.</span>
      )}
    </div>
  );
}

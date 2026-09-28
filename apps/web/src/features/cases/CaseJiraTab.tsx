'use client';

import type { CaseDetail, CaseJiraLink } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { JiraStatus } from '@/features/defects/defect-bits';
import { api, ApiError, get } from '@/lib/api';
import { ago } from '@/lib/format';

/**
 * Jira issues connected to this case — stories and tasks it verifies, and bugs found by running it —
 * each with its live Jira status (the workflow's own names, kept in sync by webhook and reconciler).
 */
export function CaseJiraTab({ c, canEdit }: { c: CaseDetail; canEdit: boolean }) {
  const { project } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const links = useQuery({
    queryKey: ['case-jira', project.id, c.key],
    queryFn: () => get<CaseJiraLink[]>(`/projects/${project.id}/cases/${c.key}/jira`),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['case-jira', project.id, c.key] });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', `/projects/${project.id}/cases/${c.key}/jira`, { jiraKey: key.trim().toUpperCase() });
      setKey('');
      await refresh();
      notify(`Linked ${key.trim().toUpperCase()}`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not link the issue', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (l: CaseJiraLink) => {
    try {
      await api('DELETE', `/projects/${project.id}/cases/${c.key}/jira/${l.id}`);
      await refresh();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not unlink', 'bad');
    }
  };

  if (links.error) {
    return <div className="empty t3" style={{ padding: 32 }}>{links.error instanceof ApiError ? links.error.message : 'Jira is not reachable.'}</div>;
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {canEdit && (
        <form className="row" style={{ gap: 8 }} onSubmit={add}>
          <input className="inp mono" style={{ width: 180 }} placeholder="PAY-4821" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Jira issue key" />
          <button className="btn sm primary" disabled={busy || !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key.trim())}>
            <Icon name="link" size={12} />Link Jira issue
          </button>
          <span className="t3" style={{ fontSize: 12 }}>A story or task this case verifies, or a known bug.</span>
        </form>
      )}
      {links.isLoading && <div className="t3">Loading Jira links…</div>}
      {links.data?.length === 0 && (
        <div className="empty t3" style={{ padding: 32 }}>
          <Icon name="bug" size={20} />
          <div>No Jira issues yet. Link the story this case verifies, or log a bug from a failed step in a run.</div>
        </div>
      )}
      {links.data && links.data.length > 0 && (
        <table className="tbl">
          <thead>
            <tr><th>Key</th><th>Type</th><th>Summary</th><th>Status</th><th>Assignee</th><th>Fix version</th><th>Linked</th><th /></tr>
          </thead>
          <tbody>
            {links.data.map((l) => (
              <tr key={l.id}>
                <td><a className="mono" href={l.jiraUrl} target="_blank" rel="noreferrer">{l.jiraKey} ↗</a></td>
                <td className="t2">{l.issueType}</td>
                <td className="trunc" style={{ maxWidth: 360 }}>{l.summary}</td>
                <td title={`Synced ${ago(l.syncedAt)}`}><JiraStatus status={l.status} category={l.statusCategory} /></td>
                <td className="t2">{l.assignee ?? '—'}</td>
                <td className="mono t3">{l.fixVersion ?? '—'}</td>
                <td className="t3">{l.via.map((v) => (v === 'case' ? 'to this case' : 'from a run')).join(', ')}</td>
                <td>{canEdit && l.via.includes('case') && <button className="ib sm" onClick={() => unlink(l)} aria-label={`Unlink ${l.jiraKey}`}><Icon name="x" size={12} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

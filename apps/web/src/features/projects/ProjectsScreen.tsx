'use client';

import type { ProjectOverview, ProjectSummary } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { ago, fmt } from '@/lib/format';
import { groupProjects, matchesProject } from '@/lib/projects';
import s from './projects.module.css';

/**
 * Every project in the organisation the user can see, grouped by product line, with the numbers that
 * say where attention is needed. Org-level project managers create, regroup and archive projects here.
 */
export function ProjectsScreen() {
  const { project: current, selectProject, canOrg, me } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['projects-overview'], queryFn: () => get<ProjectOverview[]>('/projects/overview') });
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ProjectOverview | 'new' | null>(params.get('new') ? 'new' : null);

  const permissionsOf = (id: string): ProjectSummary | undefined => me.projects.find((p) => p.id === id);
  const rows = (overview.data ?? []).filter((p) => (showArchived || !p.archived) && matchesProject(p, q));
  const groups = [...new Set((overview.data ?? []).map((p) => p.group).filter((g): g is string => !!g))].sort();

  const open = (id: string) => {
    if (id !== current.id) {
      selectProject(id);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' && query.queryKey[0] !== 'projects-overview' });
    }
    router.push('/');
  };

  return (
    <div className="page">
      <div className="page-h">
        <div>
          <h1 className="h1">Projects</h1>
          <div className="t3" style={{ fontSize: 12, marginTop: 2 }}>{me.org.name} · {overview.data?.filter((p) => !p.archived).length ?? '…'} active projects</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input className="inp" placeholder="Find a project or group" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a project" style={{ width: 220 }} />
          <label className="row t2" style={{ gap: 6, fontSize: 12.5 }}>
            <input type="checkbox" className="cb" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />Archived
          </label>
          {canOrg('project.manage') && <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" size={12} />New project</button>}
        </div>
      </div>

      {overview.isLoading && <div className="empty t3" style={{ padding: 40 }}>Loading projects…</div>}
      {groupProjects(rows).map((g) => (
        <section key={g.group} className="col" style={{ gap: 8 }}>
          <div className="sec">{g.group} <span className="t3">· {g.projects.length}</span></div>
          <div className={s.grid}>
            {g.projects.map((p) => (
              <article key={p.id} className={`${s.card} ${p.id === current.id ? s.current : ''} ${p.archived ? s.archived : ''}`}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="mono acc" style={{ fontWeight: 600 }}>{p.key}</span>
                  <b className="trunc f1">{p.name}</b>
                  {p.archived && <span className="lbl">archived</span>}
                  {p.id === current.id && <span className="st st-passed">Current</span>}
                </div>
                {p.description && <p className={`t2 ${s.desc}`}>{p.description}</p>}
                <dl className={s.stats}>
                  <div><dt>Cases</dt><dd className="num">{fmt(p.cases)}</dd></div>
                  <div><dt>Failing</dt><dd className={`num ${p.failing ? 'st-failed' : ''}`}>{fmt(p.failing)}</dd></div>
                  <div><dt>Pass · 30d</dt><dd className="num">{p.passRate === null ? '—' : `${p.passRate}%`}</dd></div>
                  <div><dt>Active runs</dt><dd className="num">{p.activeRuns}</dd></div>
                  <div><dt>Open bugs</dt><dd className="num">{p.openDefects}</dd></div>
                </dl>
                <div className="row t3" style={{ gap: 8, fontSize: 11.5 }}>
                  <span>{p.lastActivity ? `Last result ${ago(p.lastActivity)}` : 'Nothing run yet'}</span>
                  {p.members > 0 && <span>· {p.members} project members</span>}
                  <div className="f1" />
                  {permissionsOf(p.id)?.permissions.includes('project.manage') && (
                    <button className="btn sm ghost" onClick={() => setEditing(p)}>Edit</button>
                  )}
                  <button className="btn sm" onClick={() => open(p.id)}>{p.id === current.id ? 'Open' : 'Switch to'}</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
      {overview.data && rows.length === 0 && <div className="empty t3" style={{ padding: 40 }}>No project matches.</div>}

      {editing && (
        <ProjectDialog
          project={editing === 'new' ? null : editing}
          groups={groups}
          sources={(overview.data ?? []).filter((p) => !p.archived)}
          onClose={() => { setEditing(null); if (params.get('new')) router.replace('/projects'); }}
          onSaved={async (createdId) => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['me'] }),
              queryClient.invalidateQueries({ queryKey: ['projects-overview'] }),
            ]);
            setEditing(null);
            if (createdId) open(createdId);
          }}
        />
      )}
    </div>
  );
}

/** Create a project (key, name, group, optional copy of another project's module tree) or edit one. */
function ProjectDialog({ project, groups, sources, onClose, onSaved }: {
  project: ProjectOverview | null;
  groups: string[];
  sources: ProjectOverview[];
  onClose(): void;
  onSaved(createdId: string | null): void | Promise<void>;
}) {
  const { notify } = useToast();
  const [form, setForm] = useState({
    key: '',
    name: project?.name ?? '',
    group: project?.group ?? '',
    description: project?.description ?? '',
    copyModulesFrom: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (project) {
        await api('PATCH', `/projects/${project.id}`, { name: form.name, group: form.group.trim() || null, description: form.description });
        notify(`${project.key} saved`);
        await onSaved(null);
      } else {
        const created = await api<{ id: string; key: string }>('POST', '/projects', {
          key: form.key,
          name: form.name,
          group: form.group.trim() || null,
          description: form.description,
          ...(form.copyModulesFrom && { copyModulesFrom: form.copyModulesFrom }),
        });
        notify(`Project ${created.key} created`);
        await onSaved(created.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the project');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (archived: boolean) => {
    if (!project) return;
    try {
      await api('PATCH', `/projects/${project.id}`, { archived });
      notify(archived ? `${project.key} archived; its history stays readable` : `${project.key} restored`);
      await onSaved(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the project');
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className="modal" style={{ width: 480, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={submit} role="dialog" aria-labelledby="pd-title">
        <h2 id="pd-title" className="h1" style={{ fontSize: 17 }}>{project ? `Edit ${project.key}` : 'New project'}</h2>
        {!project && (
          <div className="field">
            <label htmlFor="pd-key">Key</label>
            <input id="pd-key" className="inp mono" required maxLength={10} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} placeholder="KYC" />
            <span className="t3" style={{ fontSize: 11.5 }}>Prefix for this project; it can't be changed later.</span>
          </div>
        )}
        <div className="field"><label htmlFor="pd-name">Name</label><input id="pd-name" className="inp" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Video KYC" /></div>
        <div className="field">
          <label htmlFor="pd-group">Group</label>
          <input id="pd-group" className="inp" list="pd-groups" value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} placeholder="Product line or team, e.g. Payments" />
          <datalist id="pd-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </div>
        <div className="field"><label htmlFor="pd-desc">Description</label><textarea id="pd-desc" className="inp" rows={2} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        {!project && (
          <div className="field">
            <label htmlFor="pd-copy">Start with modules from</label>
            <select id="pd-copy" className="inp" value={form.copyModulesFrom} onChange={(e) => setForm({ ...form, copyModulesFrom: e.target.value })}>
              <option value="">An empty module tree</option>
              {sources.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </select>
          </div>
        )}
        {error && <div className="err">{error}</div>}
        <div className="row" style={{ gap: 8 }}>
          {project && (
            <button type="button" className="btn ghost" onClick={() => archive(!project.archived)}>{project.archived ? 'Restore' : 'Archive'}</button>
          )}
          <div className="f1" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{project ? 'Save' : 'Create project'}</button>
        </div>
      </form>
    </>
  );
}

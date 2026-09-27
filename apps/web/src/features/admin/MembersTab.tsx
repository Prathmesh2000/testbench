'use client';

import type { AdminMember, InviteResult, RoleView } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { Avatar } from '@/components/status';
import { api, ApiError } from '@/lib/api';
import { fmt } from '@/lib/format';
import { CopyButton } from './AccessTokens';
import s from './admin.module.css';

type Pending = { kind: 'remove'; userId: string } | { kind: 'project'; userId: string; projectId: string } | null;

/** Everyone in the organisation, their org-wide and per-project roles, and invitations. */
export function MembersTab({ members, roles }: { members: AdminMember[]; roles: RoleView[] }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const shown = q ? members.filter((m) => m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q)) : members;

  /** Runs a membership change; the API's own messages (last Org Admin, grant limits) go to a toast. */
  const change = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: ['admin-members'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      setPending(null);
      setAddingFor(null);
      notify(done);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not update the member', 'bad');
    }
  };
  const setRole = (m: AdminMember, role: string, projectId: string | null, where: string) =>
    change(() => api('PUT', `/admin/members/${m.user.id}`, { role, projectId }), `${m.user.name} is now ${roleName(roles, role)} ${where}`);
  const remove = (m: AdminMember, projectId?: string) =>
    change(() => api('DELETE', `/admin/members/${m.user.id}${projectId ? `?projectId=${projectId}` : ''}`), projectId ? 'Project role removed' : `${m.user.name} removed`);

  return (
    <div className={s.stack}>
      <div className={s.bar}>
        <input className={`inp ${s.search}`} type="search" placeholder="Find people" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find people" />
        <div className="f1" />
        <button type="button" className="btn primary" onClick={() => setInviting(true)}><Icon name="plus" size={12} />Invite</button>
      </div>
      <section className={`panel ${s.tableWrap}`}>
        <div className="hdr"><h3>Members</h3><span className="cnt">{q ? `${fmt(shown.length)} of ${fmt(members.length)}` : fmt(members.length)}</span></div>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Email</th><th>Organisation role</th><th>Project roles</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.user.id}>
                <td><span className="row"><Avatar user={m.user} /><span>{m.user.name}</span>{!m.active && <span className={s.invited} title="Has not signed in yet">Invited</span>}</span></td>
                <td className="t2">{m.user.email}</td>
                <td>
                  <select className={`inp ${s.roleSelect}`} value={m.orgRole?.ref ?? ''} aria-label={`Organisation role for ${m.user.name}`}
                    onChange={(e) => setRole(m, e.target.value, null, 'across the organisation')}>
                    {!m.orgRole && <option value="" disabled>None</option>}
                    {roles.map((r) => <option key={r.ref} value={r.ref}>{r.name}</option>)}
                  </select>
                </td>
                <td>
                  <div className={s.projRoles}>
                    {m.projects.map((p) => pending?.kind === 'project' && pending.userId === m.user.id && pending.projectId === p.projectId ? (
                      <span key={p.projectId} className="row" style={{ gap: 4 }}>
                        <span className="t2" style={{ fontSize: 12 }}>Remove from {p.projectKey}?</span>
                        <button type="button" className="btn sm danger" onClick={() => remove(m, p.projectId)}>Remove</button>
                        <button type="button" className="btn sm" onClick={() => setPending(null)}>Keep</button>
                      </span>
                    ) : (
                      <span key={p.projectId} className={`lbl ${s.projRole}`}>
                        {p.projectKey}: {p.label}
                        <button type="button" aria-label={`Remove ${m.user.name} from ${p.projectKey}`} onClick={() => setPending({ kind: 'project', userId: m.user.id, projectId: p.projectId })}><Icon name="x" size={10} /></button>
                      </span>
                    ))}
                    {addingFor === m.user.id
                      ? <ProjectRoleEditor roles={roles} onCancel={() => setAddingFor(null)} onSave={(projectId, role, key) => setRole(m, role, projectId, `on ${key}`)} />
                      : <button type="button" className="btn ghost sm" onClick={() => setAddingFor(m.user.id)} aria-label={`Set a project role for ${m.user.name}`}><Icon name="plus" size={11} />Project</button>}
                  </div>
                </td>
                <td className={s.actions}>
                  {pending?.kind === 'remove' && pending.userId === m.user.id ? (
                    <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <span className="t2" style={{ fontSize: 12 }}>Remove from the organisation?</span>
                      <button type="button" className="btn sm danger" onClick={() => remove(m)}>Remove</button>
                      <button type="button" className="btn sm" onClick={() => setPending(null)}>Keep</button>
                    </span>
                  ) : (
                    <button type="button" className="btn ghost sm danger" onClick={() => setPending({ kind: 'remove', userId: m.user.id })} aria-label={`Remove ${m.user.name}`}>Remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <div className={`empty t3 ${s.message}`}>{q ? 'Nobody matches that.' : 'No members yet.'}</div>}
      </section>
      {inviting && <InviteDialog roles={roles} onClose={() => setInviting(false)} />}
    </div>
  );
}

const roleName = (roles: RoleView[], ref: string) => roles.find((r) => r.ref === ref)?.name ?? ref;

/** Inline picker for a per-project role. Org Admin is organisation-wide only, so it is not offered. */
function ProjectRoleEditor({ roles, onSave, onCancel }: { roles: RoleView[]; onSave(projectId: string, role: string, key: string): void; onCancel(): void }) {
  const { me } = useSession();
  const options = roles.filter((r) => r.ref !== 'org_admin');
  const [projectId, setProjectId] = useState(me.projects[0]?.id ?? '');
  const [role, setRole] = useState(options.find((r) => r.ref === 'tester')?.ref ?? options[0]?.ref ?? '');
  const key = me.projects.find((p) => p.id === projectId)?.key ?? '';
  return (
    <span className="row" style={{ gap: 4 }}>
      <select className={`inp ${s.roleSelect}`} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
        {me.projects.map((p) => <option key={p.id} value={p.id}>{p.key}</option>)}
      </select>
      <select className={`inp ${s.roleSelect}`} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Project role">
        {options.map((r) => <option key={r.ref} value={r.ref}>{r.name}</option>)}
      </select>
      <button type="button" className="btn sm primary" disabled={!projectId || !role} onClick={() => onSave(projectId, role, key)}>Set</button>
      <button type="button" className="btn sm" onClick={onCancel}>Cancel</button>
    </span>
  );
}

/** Invite by email. When the account is created locally, its temporary password is shown exactly once. */
function InviteDialog({ roles, onClose }: { roles: RoleView[]; onClose(): void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState(roles.find((r) => r.ref === 'tester')?.ref ?? roles[0]?.ref ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api<InviteResult>('POST', '/admin/invites', { email: email.trim(), name: name.trim(), role });
      await queryClient.invalidateQueries({ queryKey: ['admin-members'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the invite');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <form className={`modal center ${s.dialog}`} role="dialog" aria-modal="true" aria-labelledby="invite-title" onSubmit={submit}>
        <div className={`row ${s.dialogHead}`}>
          <span id="invite-title" className="cond" style={{ fontSize: 16, fontWeight: 600 }}>Invite a member</span>
          <div className="f1" />
          <button type="button" className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        {result ? (
          <div className={s.dialogBody}>
            <div className="row"><Icon name="check" className="st-passed" />{name.trim()} is invited as {roleName(roles, role)}.</div>
            {result.temporaryPassword ? (
              <>
                <div className="t2">Share this temporary password; they change it at first sign-in. It won’t be shown again.</div>
                <div className={s.secret}><code className="mono">{result.temporaryPassword}</code><CopyButton text={result.temporaryPassword} what="Password" /></div>
              </>
            ) : <div className="t2">They sign in with your organisation’s single sign-on.</div>}
          </div>
        ) : (
          <div className={s.dialogBody}>
            <div className="field">
              <label htmlFor="inv-email">Email</label>
              <input id="inv-email" className="inp" type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="inv-name">Name</label>
              <input id="inv-name" className="inp" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="inv-role">Organisation role</label>
              <select id="inv-role" className="inp" value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => <option key={r.ref} value={r.ref}>{r.name}</option>)}
              </select>
            </div>
            {error && <div className="banner bad" role="alert"><Icon name="alert" />{error}</div>}
          </div>
        )}
        <div className={`row ${s.dialogFoot}`}>
          <div className="f1" />
          {result ? <button type="button" className="btn primary" onClick={onClose}>Done</button> : (
            <>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving || !email.trim() || !name.trim() || !role}>{saving ? 'Inviting…' : 'Send invite'}</button>
            </>
          )}
        </div>
      </form>
    </>
  );
}

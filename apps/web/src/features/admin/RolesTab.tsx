'use client';

import { PERMISSION_GROUPS, type Permission, type RoleView } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { fmt } from '@/lib/format';
import { changedRoles, copyRoleBody, customRoleId, togglePermission } from './admin-utils';
import s from './admin.module.css';

const GUARDRAILS = [
  'At least one Org Admin must remain; the last one can’t be demoted or removed.',
  'You can only grant permissions you hold yourself, in roles and in memberships.',
  'Built-in roles are fixed. Copy one to make a custom role, then change its permissions.',
  'A custom role can’t be deleted while anyone holds it.',
];

/**
 * The permissions matrix: one column per role, built-ins locked, custom roles editable. Without
 * role.manage (member.manage only) the matrix is read-only.
 */
export function RolesTab({ roles, editable }: { roles: RoleView[]; editable: boolean }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, Permission[]>>({});
  const [copying, setCopying] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const permsOf = (r: RoleView) => drafts[r.ref] ?? r.permissions;
  const changed = changedRoles(roles, drafts);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
  const dropDraft = (ref: string) => setDrafts(({ [ref]: _gone, ...rest }) => rest);

  const save = async (r: RoleView) => {
    try {
      await api('PUT', `/admin/roles/${customRoleId(r.ref)}`, { name: r.name, basedOn: r.basedOn, permissions: permsOf(r) });
      await refresh();
      dropDraft(r.ref);
      notify(`${r.name} saved`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not save the role', 'bad');
    }
  };

  const remove = async (r: RoleView) => {
    try {
      await api('DELETE', `/admin/roles/${customRoleId(r.ref)}`);
      await refresh();
      dropDraft(r.ref);
      notify(`${r.name} deleted`);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not delete the role', 'bad');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className={s.stack}>
      <div className={s.bar}>
        <span className="t2" style={{ fontSize: 12.5 }}>{editable ? 'Built-in roles are locked. Copy one to make a custom role.' : 'You can see roles; changing them needs the Manage roles permission.'}</span>
        <div className="f1" />
        {editable && !copying && <button type="button" className="btn" onClick={() => setCopying(true)}>Copy role</button>}
        {changed.map((r) => <button key={r.ref} type="button" className="btn primary" onClick={() => save(r)}>Save {r.name}</button>)}
      </div>
      {copying && <CopyRoleForm roles={roles} onDone={() => setCopying(false)} />}

      <div className="panel" style={{ overflow: 'auto' }}>
        <table className={s.pm}>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {roles.map((r) => (
                <th key={r.ref} scope="col" className={r.builtIn ? undefined : s.cust}>
                  <div className={r.builtIn ? undefined : 'acc'}>{r.name}</div>
                  <div className={s.sub}>{r.builtIn ? 'built-in' : editable ? 'custom · editable' : 'custom'} · {fmt(r.holders)} {r.holders === 1 ? 'holder' : 'holders'}</div>
                  {editable && !r.builtIn && (deleting === r.ref ? (
                    <div className={s.sub}>
                      Delete? <button type="button" className={s.colDel} onClick={() => remove(r)}>Yes</button> · <button type="button" className={s.colDel} onClick={() => setDeleting(null)}>No</button>
                    </div>
                  ) : (
                    <button type="button" className={s.colDel} onClick={() => setDeleting(r.ref)} aria-label={`Delete ${r.name}`}>Delete</button>
                  ))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSION_GROUPS.flatMap((g) => [
              <tr key={g.group} className={s.grp}><td colSpan={roles.length + 1}>{g.group}</td></tr>,
              ...g.items.map((item) => (
                <tr key={item.permission}>
                  <th scope="row">{item.label}</th>
                  {roles.map((r) => {
                    const on = permsOf(r).includes(item.permission);
                    if (r.builtIn || !editable) {
                      return <td key={r.ref} className={r.builtIn ? undefined : s.cust}>{on ? <span className={s.y} aria-label="Yes"><Icon name="check" size={13} /></span> : <span className={s.n} aria-label="No">—</span>}</td>;
                    }
                    return (
                      <td key={r.ref} className={s.cust}>
                        <input type="checkbox" className="cb" checked={on} aria-label={`${item.label} for ${r.name}`}
                          onChange={() => setDrafts((d) => ({ ...d, [r.ref]: togglePermission(permsOf(r), item.permission) }))} />
                      </td>
                    );
                  })}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      <section className="panel">
        <div className="hdr"><h3>Guardrails</h3></div>
        <div className={`col ${s.guard}`}>
          {GUARDRAILS.map((g) => <span key={g} className="row"><Icon name="shield" size={13} className="acc" />{g}</span>)}
        </div>
      </section>
    </div>
  );
}

/** Pick a role to start from and name the copy. */
function CopyRoleForm({ roles, onDone }: { roles: RoleView[]; onDone(): void }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [sourceRef, setSourceRef] = useState(roles.find((r) => r.ref === 'tester')?.ref ?? roles[0]?.ref ?? '');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const source = roles.find((r) => r.ref === sourceRef);
    if (!source) return;
    setSaving(true);
    try {
      await api('POST', '/admin/roles', copyRoleBody(source, name));
      await queryClient.invalidateQueries({ queryKey: ['admin-roles'] });
      notify(`${name.trim()} created from ${source.name}`);
      onDone();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create the role', 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={`panel ${s.bar}`} style={{ padding: '10px 12px', alignItems: 'flex-end' }} onSubmit={submit} aria-label="Copy role">
      <div className="field">
        <label htmlFor="copy-src">Copy from</label>
        <select id="copy-src" className="inp" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)}>
          {roles.map((r) => <option key={r.ref} value={r.ref}>{r.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="copy-name">New role name</label>
        <input id="copy-name" className="inp" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Release Manager" />
      </div>
      <button type="submit" className="btn primary" disabled={saving || !name.trim()}>{saving ? 'Creating…' : 'Create role'}</button>
      <button type="button" className="btn" onClick={onDone}>Cancel</button>
    </form>
  );
}

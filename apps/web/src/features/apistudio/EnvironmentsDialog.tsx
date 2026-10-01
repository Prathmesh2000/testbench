'use client';

import type { ApiEnvironment, ApiNode, ApiVariable, ApiWorkspace, CookieView } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError, get } from '@/lib/api';
import { dateTimeIST } from '@/lib/format';
import { CertsPanel, ProfilesPanel, TargetsPanel } from './AuthPanels';
import { VariableTable } from './fields';
import { useLocals } from './locals';
import s from './apistudio.module.css';

type Pick = { kind: 'workspace' } | { kind: 'env'; id: string } | { kind: 'new' } | { kind: 'profiles' } | { kind: 'certs' } | { kind: 'targets' };
const strip = (vs: ApiVariable[]) => vs.map(({ hasValue: _h, ...v }) => v);

/**
 * Workspace settings: environments (dev, qa, uat), the workspace's own variables, this tester's session
 * values and saved cookies, auth profiles and client certificates.
 */
export function EnvironmentsDialog({ base, projectBase, workspace, environments, activeId, canEdit, requests, onClose }: {
  base: string;
  projectBase: string;
  workspace: ApiWorkspace;
  environments: ApiEnvironment[];
  activeId: string | null;
  canEdit: boolean;
  /** Requests in the workspace, for picking a profile's login. */
  requests: ApiNode[];
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [pick, setPick] = useState<Pick>(activeId ? { kind: 'env', id: activeId } : { kind: 'workspace' });
  const env = pick.kind === 'env' ? environments.find((e) => e.id === pick.id) ?? null : null;
  const initial = pick.kind === 'workspace' ? workspace.variables : env?.variables ?? [];
  const [name, setName] = useState('');
  const [vars, setVars] = useState<ApiVariable[]>(initial);
  const [production, setProduction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locals = useLocals(workspace.id, pick.kind === 'env' ? pick.id : null);
  const cookieEnv = pick.kind === 'env' ? pick.id : null;
  const cookies = useQuery({
    queryKey: ['apitest', 'cookies', workspace.id, cookieEnv],
    queryFn: () => get<CookieView[]>(`${base}/cookies${cookieEnv ? `?environmentId=${cookieEnv}` : ''}`),
    enabled: pick.kind === 'workspace' || pick.kind === 'env',
  });

  useEffect(() => {
    setVars(pick.kind === 'new' ? [{ key: 'baseUrl', value: '', secret: false, enabled: true }] : initial);
    setName(env?.name ?? '');
    setProduction(env?.production ?? false);
    setError(null);
    // Reset when another list entry is picked or it is saved, so typing is not overwritten by refetches.
  }, [pick.kind, env?.id, env?.updatedAt, workspace.updatedAt]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['apitest', 'envs', workspace.id] });
    queryClient.invalidateQueries({ queryKey: ['apitest', 'workspaces'] });
  };
  const save = async () => {
    setError(null);
    try {
      if (pick.kind === 'workspace') await api('PATCH', base, { variables: strip(vars) });
      else if (pick.kind === 'new') {
        const created = await api<ApiEnvironment>('POST', `${base}/environments`, { name, variables: strip(vars), production });
        setPick({ kind: 'env', id: created.id });
      } else if (pick.kind === 'env') await api('PUT', `${base}/environments/${pick.id}`, { name, variables: strip(vars), production });
      refresh();
      notify('Saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };
  const remove = async () => {
    if (!env || !window.confirm(`Delete the environment "${env.name}"?`)) return;
    await api('DELETE', `${base}/environments/${env.id}`);
    setPick({ kind: 'workspace' });
    refresh();
  };
  const clearCookies = async () => {
    await api('DELETE', `${base}/cookies${cookieEnv ? `?environmentId=${cookieEnv}` : ''}`);
    cookies.refetch();
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={`modal center ${s.dialog}`} role="dialog" aria-labelledby="env-title">
        <div className="hdr">
          <h3 id="env-title">Workspace settings</h3>
          <div className="f1" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon name="x" size={13} /></button>
        </div>
        <div className={s.dialogBody}>
          <div className={s.dialogList}>
            <button className={`${s.row} ${pick.kind === 'workspace' ? s.on : ''}`} onClick={() => setPick({ kind: 'workspace' })}><Icon name="globe" size={13} />Workspace variables</button>
            <div className="t3" style={{ fontSize: 11.5, padding: '10px 10px 4px' }}>ENVIRONMENTS</div>
            {environments.map((e) => (
              <button key={e.id} className={`${s.row} ${pick.kind === 'env' && pick.id === e.id ? s.on : ''}`} onClick={() => setPick({ kind: 'env', id: e.id })}>
                <span className="trunc">{e.name}</span>
                <span className={s.count} style={{ marginLeft: 'auto' }}>{e.variables.length}</span>
              </button>
            ))}
            {canEdit && <button className={`${s.row} ${pick.kind === 'new' ? s.on : ''}`} onClick={() => setPick({ kind: 'new' })}><Icon name="plus" size={12} />New environment</button>}
            <div className="t3" style={{ fontSize: 11.5, padding: '10px 10px 4px' }}>SECURITY</div>
            <button className={`${s.row} ${pick.kind === 'profiles' ? s.on : ''}`} onClick={() => setPick({ kind: 'profiles' })}><Icon name="shield" size={13} />Auth profiles</button>
            <button className={`${s.row} ${pick.kind === 'certs' ? s.on : ''}`} onClick={() => setPick({ kind: 'certs' })}><Icon name="paperclip" size={13} />Client certificates</button>
            <button className={`${s.row} ${pick.kind === 'targets' ? s.on : ''}`} onClick={() => setPick({ kind: 'targets' })}><Icon name="flag" size={13} />Safe targets</button>
          </div>
          <div className={s.dialogMain}>
            {pick.kind === 'profiles' && <ProfilesPanel base={base} workspaceId={workspace.id} requests={requests} canEdit={canEdit} />}
            {pick.kind === 'certs' && <CertsPanel base={base} workspaceId={workspace.id} canEdit={canEdit} />}
            {pick.kind === 'targets' && <TargetsPanel projectBase={projectBase} canEdit={canEdit} />}
            {(pick.kind === 'workspace' || pick.kind === 'env' || pick.kind === 'new') && (
            <>
            {pick.kind !== 'workspace' && (
              <div className="field">
                <label htmlFor="env-name">Name</label>
                <input id="env-name" className="inp" value={name} placeholder="qa" readOnly={!canEdit} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div className="t3" style={{ fontSize: 12 }}>
              {pick.kind === 'workspace'
                ? 'Used by every request in the workspace, whatever environment is active. An environment’s value wins over these.'
                : 'Pick the active environment at the top of API Studio. Mark tokens and passwords as secret: they are stored encrypted and never shown again.'}
            </div>
            <VariableTable rows={vars} onChange={setVars} readOnly={!canEdit} />
            {pick.kind !== 'workspace' && (
              <label style={{ fontSize: 12.5, display: 'flex', gap: 6 }}>
                <input type="checkbox" checked={production} disabled={!canEdit} onChange={(e) => setProduction(e.target.checked)} />
                <span><b>Production.</b> Load tests and attack probes against it are refused unless a project admin overrides, each time.</span>
              </label>
            )}
            {error && <div className="err" role="alert">{error}</div>}
            {canEdit && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={save} disabled={pick.kind === 'new' && !name.trim()}>Save</button>
                {env && <button className="btn danger" onClick={remove}>Delete environment</button>}
              </div>
            )}
            {pick.kind !== 'new' && (
              <>
                <section>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <h4 style={{ margin: 0, fontSize: 12.5 }}>Your session values</h4>
                    <div className="f1" />
                    {Object.keys(locals.values).length > 0 && <button className="btn sm" onClick={locals.clear}>Clear</button>}
                  </div>
                  <div className="t3" style={{ fontSize: 12, marginBottom: 6 }}>Values your requests extracted{pick.kind === 'env' ? ' in this environment' : ' with no environment'}. Only in this browser; they win over every other scope.</div>
                  {Object.entries(locals.values).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'center' }}>
                      <span className="mono">{k}</span><span className="mono t2 trunc" style={{ flex: 1 }}>{v}</span>
                      <button className="btn ghost sm" aria-label={`Forget ${k}`} onClick={() => locals.remove(k)}><Icon name="x" size={11} /></button>
                    </div>
                  ))}
                  {Object.keys(locals.values).length === 0 && <div className="t3" style={{ fontSize: 12 }}>None yet.</div>}
                </section>
                <section>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <h4 style={{ margin: 0, fontSize: 12.5 }}>Your saved cookies</h4>
                    <div className="f1" />
                    {(cookies.data?.length ?? 0) > 0 && <button className="btn sm" onClick={clearCookies}>Clear</button>}
                  </div>
                  <div className="t3" style={{ fontSize: 12, marginBottom: 6 }}>Cookies your requests received, sent back on later requests like a browser would. Stored encrypted, only for you.</div>
                  {cookies.data?.map((c) => (
                    <div key={`${c.domain}${c.path}${c.name}`} className="mono t2" style={{ fontSize: 12 }}>
                      {c.name} · {c.domain}{c.path}{c.httpOnly ? ' · HttpOnly' : ''}{c.secure ? ' · Secure' : ''}{c.expires ? ` · until ${dateTimeIST(c.expires)}` : ' · session'}
                    </div>
                  ))}
                  {cookies.data?.length === 0 && <div className="t3" style={{ fontSize: 12 }}>None yet.</div>}
                </section>
              </>
            )}
            </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

'use client';

import type { AdminMember, Integration, IntegrationState, Permission, RoleView } from '@tb/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { useSession } from '@/components/providers';
import { AiSettings } from '@/features/ai/AiSettings';
import { ApiError, get } from '@/lib/api';
import { ago, fmt, initials } from '@/lib/format';
import { AuditTab } from './AuditTab';
import { MembersTab } from './MembersTab';
import { RolesTab } from './RolesTab';
import s from './admin.module.css';

type Tab = 'members' | 'roles' | 'integrations' | 'ai' | 'audit';

/**
 * Tab visibility uses the current project's permissions, which approximates the org-level grants the
 * API checks; when they differ the API answers 403 and the tab shows its message.
 */
const TABS: { id: Tab; label: string; needs: Permission[] }[] = [
  { id: 'members', label: 'Members', needs: ['member.manage'] },
  { id: 'roles', label: 'Roles', needs: ['role.manage', 'member.manage'] },
  { id: 'integrations', label: 'Integrations', needs: ['project.manage'] },
  { id: 'ai', label: 'AI providers', needs: ['ai.use'] },
  { id: 'audit', label: 'Audit log', needs: ['audit.read'] },
];

const STATE: Record<IntegrationState, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'st-passed' },
  local: { label: 'Local', className: 'st-passed' },
  not_configured: { label: 'Not configured', className: 'st-blocked' },
  error: { label: 'Error', className: 'st-failed' },
};

/** Organisation admin console: members, roles, integrations, AI providers and the audit log. */
export function AdminScreen() {
  const { me, can } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabs = TABS.filter((t) => t.needs.some(can));
  const tab = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id;

  const members = useQuery({ queryKey: ['admin-members'], queryFn: () => get<AdminMember[]>('/admin/members'), enabled: can('member.manage') });
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<RoleView[]>('/admin/roles'), enabled: tab === 'members' || tab === 'roles' });

  const select = (id: Tab) => router.replace(`${pathname}?tab=${id}`, { scroll: false });

  if (!tab) {
    return <div className="page"><div className="empty" style={{ flex: 1 }}><Icon name="shield" size={22} /><div>You don’t have access to the admin console.</div><div className="t3">Ask an Org Admin if you need it.</div></div></div>;
  }

  return (
    <div className={s.screen}>
      <div className={`row ${s.head}`}>
        <h1 className="h1">Admin</h1>
        <div className="tabs" role="tablist" aria-label="Admin sections">
          {tabs.map((t) => (
            <button key={t.id} id={`admin-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls="admin-panel" className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => select(t.id)}>
              {t.label}
              {t.id === 'members' && members.data && <span className="n">{fmt(members.data.length)}</span>}
            </button>
          ))}
        </div>
        <div className="f1" />
        <span className="t3" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Organisation: {me.org.name}</span>
      </div>
      <div id="admin-panel" role="tabpanel" aria-labelledby={`admin-tab-${tab}`} className={s.body}>
        {tab === 'members' && <Loaded queries={[members, roles]}>{() => <MembersTab members={members.data!} roles={roles.data!} />}</Loaded>}
        {tab === 'roles' && <Loaded queries={[roles]}>{() => <RolesTab roles={roles.data!} editable={can('role.manage')} />}</Loaded>}
        {tab === 'integrations' && <Integrations />}
        {tab === 'ai' && <div className="col" style={{ gap: 14, maxWidth: 1080 }}><AiSettings /></div>}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}

/** Renders children once every query has data; otherwise the loading state or the API's error (e.g. 403). */
function Loaded({ queries, children }: { queries: UseQueryResult[]; children: () => ReactNode }) {
  const failed = queries.find((q) => q.error)?.error;
  if (failed) return <div className={`panel empty ${s.message}`}><Icon name="alert" size={20} />{failed instanceof ApiError ? failed.message : 'Could not load this section.'}</div>;
  if (queries.some((q) => !q.data)) return <div className={`empty t3 ${s.message}`}>Loading…</div>;
  return <>{children()}</>;
}

/** Connected services and their health, as reported by core-api. */
function Integrations() {
  const list = useQuery({ queryKey: ['admin-integrations'], queryFn: () => get<Integration[]>('/admin/integrations') });
  const attention = list.data?.filter((i) => i.state === 'error' || i.state === 'not_configured').length ?? 0;
  return (
    <Loaded queries={[list]}>
      {() => (
        <section className="panel" style={{ overflow: 'hidden', flexShrink: 0 }}>
          <div className="hdr"><h3>Integrations</h3><span className="cnt">{list.data!.length}{attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}</span></div>
          {list.data!.map((i) => (
            <div key={i.id} className={s.int}>
              <span className={s.lg} aria-hidden>{initials(i.name)}</span>
              <div className="col" style={{ gap: 2, minWidth: 0 }}><b style={{ fontWeight: 500 }}>{i.name}</b><span className="t3 trunc" style={{ fontSize: 12 }}>{i.detail}</span></div>
              <span className={`st ${STATE[i.state].className}`} style={{ fontWeight: 400 }}>{STATE[i.state].label}</span>
              <span className="t3" style={{ fontSize: 12 }}>Last sync {i.lastSync ? ago(i.lastSync) : '—'}</span>
            </div>
          ))}
        </section>
      )}
    </Loaded>
  );
}

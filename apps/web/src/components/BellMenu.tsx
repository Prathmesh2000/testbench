'use client';

import type { InboxItem } from '@tb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, get } from '@/lib/api';
import { ago } from '@/lib/format';
import { Icon } from './Icon';
import { useSession } from './providers';

interface Inbox {
  items: InboxItem[];
  unread: number;
}

/**
 * The in-app channel. Polls every 20 seconds.
 * ponytail: polling rather than a WebSocket push (HLD §5.7 uses API Gateway WebSockets in AWS);
 * add the push channel when 20 seconds of delay starts to matter.
 */
export function useInbox() {
  return useQuery({ queryKey: ['inbox'], queryFn: () => get<Inbox>('/me/notifications'), refetchInterval: 20_000, retry: false });
}

export function BellMenu({ onClose }: { onClose(): void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const inbox = useInbox();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const items = (inbox.data?.items ?? []).filter((i) => tab === 'all' || !i.read);

  const markRead = async (ids: string[]) => {
    if (!ids.length) return;
    await api('POST', '/me/notifications/read', { ids });
    await queryClient.invalidateQueries({ queryKey: ['inbox'] });
  };
  const open = async (item: InboxItem) => {
    await markRead([item.id]);
    onClose();
    if (item.link) router.push(new URL(item.link).pathname + new URL(item.link).search);
  };

  return (
    <>
      <div className="scrim" style={{ background: 'transparent' }} onClick={onClose} />
      <div className="modal bell" role="dialog" aria-label="Notifications">
        <div className="row" style={{ padding: '0 8px 0 6px', borderBottom: '1px solid var(--border)' }}>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'all'} className={`tab ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>All</button>
            <button role="tab" aria-selected={tab === 'unread'} className={`tab ${tab === 'unread' ? 'on' : ''}`} onClick={() => setTab('unread')}>Unread <span className="n">{inbox.data?.unread ?? 0}</span></button>
          </div>
          <div className="f1" />
          <button className="btn sm ghost" disabled={!inbox.data?.unread} onClick={() => markRead(inbox.data!.items.filter((i) => !i.read).map((i) => i.id))}>Mark all read</button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {inbox.error && <div className="empty t3" style={{ padding: 28, fontSize: 12.5 }}>Notifications are not available right now.</div>}
          {inbox.data && items.length === 0 && (
            <div className="empty" style={{ padding: '32px 20px' }}><Icon name="bell" size={20} /><div>{tab === 'unread' ? 'You are all caught up.' : 'Nothing here yet.'}</div></div>
          )}
          {items.map((i) => (
            <button key={i.id} className="mi" style={{ height: 'auto', padding: '10px 14px 10px 18px', alignItems: 'flex-start', position: 'relative', borderRadius: 0, borderBottom: '1px solid var(--soft)' }} onClick={() => open(i)}>
              {!i.read && <span style={{ position: 'absolute', left: 6, top: 16, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />}
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: i.read ? 400 : 600, lineHeight: 1.4 }}>{i.title}</span>
                <span className="t2" style={{ fontSize: 12, lineHeight: 1.4 }}>{i.body}</span>
                <span className="t3" style={{ fontSize: 11 }}>{ago(i.at)}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="row" style={{ height: 38, padding: '0 14px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
          {can('project.manage') && <Link href="/notifications" onClick={onClose}>Open notification console</Link>}
          <div className="f1" />
          <Link href="/settings" onClick={onClose} className="t2">Preferences</Link>
        </div>
      </div>
    </>
  );
}

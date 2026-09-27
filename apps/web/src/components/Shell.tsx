'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { globalAction, isTypingTarget } from '@/lib/keys';
import { BellMenu, useInbox } from './BellMenu';
import { CommandPalette } from './CommandPalette';
import { Icon, type IconName } from './Icon';
import { useJobs, usePrefs, useSession } from './providers';
import { ShortcutSheet } from './ShortcutSheet';
import { Avatar } from './status';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Milestone that brings this area; shown as "coming soon" until then. */
  soon?: string;
}

const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Work', items: [
    { href: '/', label: 'Home', icon: 'home' },
    { href: '/cases', label: 'Test cases', icon: 'cases' },
    { href: '/runs', label: 'Runs', icon: 'runs' },
    { href: '/defects', label: 'Defects', icon: 'bug' },
  ] },
  { group: 'Explore', items: [
    { href: '/search', label: 'Search', icon: 'search' },
    { href: '/soon/analytics', label: 'Analytics', icon: 'chart', soon: 'M4' },
  ] },
  { group: 'Knowledge', items: [
    { href: '/soon/docs', label: 'Docs & PRDs', icon: 'doc', soon: 'M4' },
    { href: '/soon/boards', label: 'Boards', icon: 'board', soon: 'M5' },
    { href: '/soon/meetings', label: 'Meetings', icon: 'calendar', soon: 'M5' },
  ] },
  { group: 'System', items: [
    { href: '/notifications', label: 'Notifications', icon: 'bell' },
    { href: '/settings', label: 'Settings', icon: 'gear' },
    { href: '/soon/admin', label: 'Admin', icon: 'shield', soon: 'M5' },
  ] },
];

const isActive = (pathname: string, href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

/** The persistent frame around every screen: top bar, navigation, status bar and global overlays. */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, project } = useSession();
  const prefs = usePrefs();
  const { jobs } = useJobs();
  const [overlay, setOverlay] = useState<'palette' | 'keys' | 'bell' | 'user' | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [pendingG, setPendingG] = useState(false);
  const gTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOverlay(null);
        return;
      }
      const action = globalAction(e, isTypingTarget(e.target), pendingG);
      if (!action) {
        if (pendingG) setPendingG(false);
        return;
      }
      e.preventDefault();
      if (action.type === 'palette' || action.type === 'search') setOverlay('palette');
      if (action.type === 'shortcuts') setOverlay('keys');
      if (action.type === 'go') {
        setPendingG(false);
        router.push(action.to);
      }
      if (action.type === 'pending-g') {
        setPendingG(true);
        clearTimeout(gTimer.current);
        gTimer.current = setTimeout(() => setPendingG(false), 1200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingG, router]);

  useEffect(() => setNavOpen(false), [pathname]);

  const running = jobs.find((j) => j.status === 'queued' || j.status === 'running');
  const unread = useInbox().data?.unread ?? 0;

  return (
    <div className={`app ${navOpen ? 'navopen' : ''}`}>
      <header className="top">
        <button className="ib show-phone" aria-label="Open navigation" onClick={() => setNavOpen((o) => !o)}><Icon name="menu" /></button>
        <Link href="/" className="logo"><span className="mk"><Icon name="check" size={14} /></span><b>Testbench</b></Link>
        <span className="proj hide-phone" title={project.name}><span className="mono t2">{project.key}</span>{project.name}</span>
        <button className="cmdk" onClick={() => setOverlay('palette')} aria-label="Search and commands">
          <Icon name="search" size={14} />
          <span className="ph">Jump to a case or run, or type a command</span>
          <span className="kbd hide-phone">Ctrl K</span>
        </button>
        <div className="f1" />
        <button className="ib" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} onClick={() => setOverlay(overlay === 'bell' ? null : 'bell')}>
          <Icon name="bell" />
          {unread > 0 && <span className="bellc">{unread > 99 ? '99+' : unread}</span>}
        </button>
        <button className="ib" aria-label={`Switch to ${prefs.theme === 'dark' ? 'light' : 'dark'} theme`} onClick={prefs.toggleTheme}><Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button className="ib hide-phone" aria-label={`Switch to ${prefs.density === 'compact' ? 'comfortable' : 'compact'} rows`} title="Row density" onClick={prefs.toggleDensity}><Icon name="rows" /></button>
        <button className="ib hide-phone" aria-label="Keyboard shortcuts" onClick={() => setOverlay('keys')}><Icon name="keyboard" /></button>
        <button className="ib" aria-label="Account" onClick={() => setOverlay(overlay === 'user' ? null : 'user')}><Avatar user={me.user} /></button>
      </header>

      <div className="app-body">
        <nav className="nav" aria-label="Main">
          {NAV.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="ng"><span>{g.group}</span></div>
              {g.items.map((item) => (
                <Link key={item.href} href={item.href} className={`ni ${isActive(pathname, item.href) ? 'on' : ''} ${item.soon ? 'soon' : ''}`} title={item.soon ? `${item.label} arrives in ${item.soon}` : item.label}>
                  <Icon name={item.icon} />
                  <span className="nl">{item.label}</span>
                  {item.soon && <span className="nc">{item.soon}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <main className="app-main">{children}</main>
      </div>

      <footer className="sb">
        <span className="row" style={{ gap: 5 }}><span className="dot ok" />Connected</span>
        <span className="sep">·</span>
        <span className="hide-phone">{me.org.name} · {project.key}</span>
        {running && (
          <>
            <span className="sep">·</span>
            <span className="row" style={{ gap: 6 }}>
              <Icon name="refresh" size={12} className="spin acc" />
              {running.label} ({running.total ? Math.round((running.processed / running.total) * 100) : 0}%)
              <span className="mini"><i style={{ width: `${running.total ? (running.processed / running.total) * 100 : 0}%` }} /></span>
            </span>
          </>
        )}
        {pendingG && <span className="gk">g …</span>}
        <div className="f1" />
        <span className="hide-phone">Press <span className="kbd">?</span> for shortcuts</span>
      </footer>

      {overlay === 'palette' && <CommandPalette onClose={() => setOverlay(null)} />}
      {overlay === 'keys' && <ShortcutSheet onClose={() => setOverlay(null)} />}
      {overlay === 'bell' && <BellMenu onClose={() => setOverlay(null)} />}
      {overlay === 'user' && (
        <>
          <div className="scrim" style={{ background: 'transparent' }} onClick={() => setOverlay(null)} />
          <div className="menu" style={{ position: 'fixed', top: 44, right: 10, width: 240 }} role="menu">
            <div style={{ padding: '8px 8px 10px' }}>
              <div style={{ fontWeight: 600 }}>{me.user.name}</div>
              <div className="t3" style={{ fontSize: 12 }}>{me.user.email}</div>
            </div>
            <form action="/auth/logout" method="post">
              <button className="mi" type="submit"><Icon name="signout" />Sign out</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

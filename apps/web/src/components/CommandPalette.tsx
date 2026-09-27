'use client';

import type { CaseRow, Page, RunSummary } from '@tb/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, qs } from '@/lib/api';
import { Icon, type IconName } from './Icon';
import { usePrefs, useSession } from './providers';

interface Item {
  id: string;
  section: string;
  label: string;
  icon: IconName;
  hint?: string;
  run(): void;
}

/** Ctrl K: jump to any case or run by key or title, navigate, or run a command. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { project } = useSession();
  const prefs = usePrefs();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);

  const cases = useQuery({
    queryKey: ['palette-cases', project.id, debounced],
    queryFn: () => get<Page<CaseRow>>(`/projects/${project.id}/cases${qs({ q: debounced, limit: 8 })}`),
    enabled: debounced.length >= 2,
  });
  const runs = useQuery({ queryKey: ['runs', project.id, 'active'], queryFn: () => get<RunSummary[]>(`/projects/${project.id}/runs?status=active`) });

  const items = useMemo<Item[]>(() => {
    const go = (href: string) => () => { router.push(href); onClose(); };
    const q = query.trim().toLowerCase();
    const matches = (s: string) => !q || s.toLowerCase().includes(q);
    const out: Item[] = [];
    for (const c of cases.data?.items ?? []) {
      out.push({ id: c.id, section: 'Test cases', label: c.title, hint: c.key, icon: 'cases', run: go(`/cases/${c.key}`) });
    }
    for (const r of runs.data ?? []) {
      if (matches(`${r.key} ${r.name}`)) out.push({ id: r.id, section: 'Active runs', label: r.name, hint: r.key, icon: 'play', run: go(`/runs/${r.id}`) });
    }
    const commands: Omit<Item, 'section'>[] = [
      { id: 'go-home', label: 'Go to Home', icon: 'home', hint: 'g h', run: go('/') },
      { id: 'go-cases', label: 'Go to Test cases', icon: 'cases', hint: 'g c', run: go('/cases') },
      { id: 'go-runs', label: 'Go to Runs', icon: 'runs', hint: 'g r', run: go('/runs') },
      { id: 'new-run', label: 'Create a run', icon: 'plus', hint: 'g n', run: go('/runs/new') },
      { id: 'new-case', label: 'New test case', icon: 'plus', run: go('/cases?new=1') },
      { id: 'theme', label: `Switch to ${prefs.theme === 'dark' ? 'light' : 'dark'} theme`, icon: prefs.theme === 'dark' ? 'sun' : 'moon', run: () => { prefs.toggleTheme(); onClose(); } },
      { id: 'density', label: `Use ${prefs.density === 'compact' ? 'comfortable' : 'compact'} rows`, icon: 'rows', run: () => { prefs.toggleDensity(); onClose(); } },
    ];
    for (const c of commands) if (matches(c.label)) out.push({ ...c, section: 'Commands' });
    return out.slice(0, 30);
  }, [cases.data, runs.data, query, prefs, router, onClose]);

  useEffect(() => setSelected(0), [query, items.length]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); items[selected]?.run(); }
  };

  let lastSection = '';
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal pal" role="dialog" aria-label="Command palette">
        <div className="pal-in">
          <Icon name="search" size={18} />
          <input
            className="pal-inp" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Search cases and runs, or type a command…" aria-label="Search cases, runs and commands"
          />
          {cases.isFetching && <Icon name="refresh" size={14} className="spin" />}
        </div>
        <div className="pal-list" ref={listRef}>
          {items.map((it, i) => {
            const header = it.section !== lastSection ? <div className="pal-h">{it.section}</div> : null;
            lastSection = it.section;
            return (
              <div key={it.id}>
                {header}
                <button className={`pal-it ${i === selected ? 'sel' : ''}`} data-sel={i === selected} onMouseEnter={() => setSelected(i)} onClick={it.run}>
                  <Icon name={it.icon} size={15} />
                  {it.section !== 'Commands' && <span className="pk">{it.hint}</span>}
                  <span className="pl">{it.label}</span>
                  {it.section === 'Commands' && it.hint && <span className="kbd">{it.hint}</span>}
                </button>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="empty" style={{ height: 140 }}>
              <Icon name="search" size={20} />
              <div>No cases, runs or commands match “{query}”</div>
            </div>
          )}
        </div>
        <div className="pal-f">
          <span><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span><span className="kbd">Enter</span> open</span>
          <span><span className="kbd">Esc</span> close</span>
        </div>
      </div>
    </>
  );
}

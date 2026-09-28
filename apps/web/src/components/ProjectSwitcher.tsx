'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { groupProjects, landingAfterSwitch, matchesProject } from '@/lib/projects';
import { Icon } from './Icon';
import { useSession } from './providers';

/**
 * The project picker in the top bar: every project the user can see, grouped by product line, with a
 * filter box once there are more than a handful. Switching lands on the same area of the new project.
 */
export function ProjectSwitcher() {
  const { me, project, selectProject, canOrg } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (id: string) => {
    setOpen(false);
    setQ('');
    if (id === project.id) return;
    selectProject(id);
    // Screens key their queries by project id, but the cheap reset also drops the old project's cache.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
    router.push(landingAfterSwitch(pathname));
  };

  const visible = me.projects.filter((p) => (showArchived || !p.archived || p.id === project.id) && matchesProject(p, q));
  const archivedCount = me.projects.filter((p) => p.archived).length;

  return (
    <div ref={box} style={{ position: 'relative' }} className="hide-phone">
      <button className="proj" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Switch project">
        <span className="mono acc" style={{ fontWeight: 500 }}>{project.key}</span>
        <span className="t3">·</span>
        {project.name}
        {project.archived && <span className="lbl">archived</span>}
        <Icon name="chevDown" size={13} className="t3" />
      </button>
      {open && (
        <div className="menu" style={{ top: 32, left: 0, width: 320, maxHeight: 440, display: 'flex', flexDirection: 'column' }} role="listbox" aria-label="Projects">
          {me.projects.length > 6 && (
            <input className="inp" autoFocus placeholder="Find a project" value={q} onChange={(e) => setQ(e.target.value)} style={{ margin: 4 }} aria-label="Find a project"
              onKeyDown={(e) => { if (e.key === 'Enter' && visible[0]) choose(visible[0].id); }} />
          )}
          <div style={{ overflow: 'auto', flex: 1 }}>
            {groupProjects(visible).map((g) => (
              <div key={g.group}>
                <div className="sec" style={{ padding: '8px 8px 4px' }}>{g.group}</div>
                {g.projects.map((p) => (
                  <button key={p.id} role="option" aria-selected={p.id === project.id} className="mi" onClick={() => choose(p.id)}>
                    <span className="mono" style={{ width: 44, color: p.id === project.id ? 'var(--accent)' : undefined }}>{p.key}</span>
                    <span className="trunc f1">{p.name}</span>
                    {p.archived && <span className="t3" style={{ fontSize: 11 }}>archived</span>}
                    {p.id === project.id && <Icon name="check" size={13} />}
                  </button>
                ))}
              </div>
            ))}
            {visible.length === 0 && <div className="t3" style={{ padding: 10, fontSize: 12 }}>No project matches “{q}”.</div>}
          </div>
          <div className="row" style={{ gap: 6, borderTop: '1px solid var(--border)', padding: '6px 4px 2px' }}>
            <Link className="btn sm ghost" href="/projects" onClick={() => setOpen(false)}>All projects</Link>
            {canOrg('project.manage') && <Link className="btn sm ghost" href="/projects?new=1" onClick={() => setOpen(false)}><Icon name="plus" size={12} />New project</Link>}
            <div className="f1" />
            {archivedCount > 0 && (
              <label className="row t3" style={{ gap: 4, fontSize: 11.5 }}>
                <input type="checkbox" className="cb" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />archived
              </label>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

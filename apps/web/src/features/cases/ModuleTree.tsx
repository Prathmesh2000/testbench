'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { useSession, useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { fmt } from '@/lib/format';
import type { ModuleInfo } from './data';
import s from './cases.module.css';

interface Props {
  tree: { byId: Map<string, ModuleInfo>; roots: string[]; total: number } | undefined;
  selected?: string;
  onSelect(id: string | undefined): void;
}

/** Functionality tree with rolled-up case counts. Selecting a node filters the grid to its subtree. */
export function ModuleTree({ tree, selected, onSelect }: Props) {
  const { project, can } = useSession();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);

  /** New modules go under the selected one, or at the top when "All cases" is selected. */
  const addModule = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = adding?.trim();
    if (!name) return setAdding(null);
    try {
      await api('POST', `/projects/${project.id}/modules`, { name, parentId: selected ?? null });
      await queryClient.invalidateQueries({ queryKey: ['modules', project.id] });
      if (selected) setOpen((o) => new Set(o).add(selected));
      setAdding(null);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not add the module', 'bad');
    }
  };
  const toggle = (id: string) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderNode = (id: string): React.ReactNode => {
    const node = tree!.byId.get(id)!;
    const isOpen = open.has(id);
    return (
      <div key={id} role="treeitem" aria-expanded={node.children.length ? isOpen : undefined} aria-selected={selected === id}>
        <button className={`${s.tn} ${selected === id ? s.on : ''}`} style={{ paddingLeft: 6 + node.depth * 14 }} onClick={() => onSelect(id)}>
          <span
            className={`${s.cv} ${isOpen ? s.open : ''}`}
            onClick={(e) => { e.stopPropagation(); toggle(id); }}
            style={{ visibility: node.children.length ? 'visible' : 'hidden' }}
          >
            <Icon name="chevRight" size={12} />
          </span>
          <span className="trunc">{node.name}</span>
          {node.failing > 0 && <span className="dot bad" title={`${fmt(node.failing)} failing`} />}
          <span className={s.c}>{fmt(node.total)}</span>
        </button>
        {isOpen && node.children.map(renderNode)}
      </div>
    );
  };

  return (
    <aside className={s.tree} aria-label="Modules">
      <div className="hdr">
        <h3>Modules</h3>
        <div className="f1" />
        {can('case.write') && (
          <button className="ib sm" aria-label={selected ? `Add a module under ${tree?.byId.get(selected)?.name ?? 'this module'}` : 'Add a top-level module'}
            title={selected ? `Add under ${tree?.byId.get(selected)?.name ?? 'selected'}` : 'Add a top-level module'} onClick={() => setAdding('')}>
            <Icon name="plus" size={13} />
          </button>
        )}
      </div>
      {adding !== null && (
        <form onSubmit={addModule} style={{ padding: '6px 8px 0' }}>
          <input className="inp" autoFocus placeholder={selected ? `New module under ${tree?.byId.get(selected)?.name ?? ''}` : 'New top-level module'}
            value={adding} onChange={(e) => setAdding(e.target.value)} onBlur={() => !adding.trim() && setAdding(null)}
            onKeyDown={(e) => { if (e.key === 'Escape') setAdding(null); }} aria-label="Module name" style={{ width: '100%' }} />
        </form>
      )}
      <div role="tree" style={{ flex: 1, overflow: 'auto', padding: 6 }}>
        <button className={`${s.tn} ${!selected ? s.on : ''}`} style={{ paddingLeft: 6 }} onClick={() => onSelect(undefined)}>
          <span className={s.cv}><Icon name="tree" size={13} /></span>
          <span className="trunc">All cases</span>
          <span className={s.c}>{tree ? fmt(tree.total) : ''}</span>
        </button>
        {tree?.roots.map(renderNode)}
      </div>
    </aside>
  );
}

'use client';

import { useState } from 'react';
import { Icon } from '@/components/Icon';
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
  const [open, setOpen] = useState<Set<string>>(new Set());
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
      <div className="hdr"><h3>Modules</h3></div>
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

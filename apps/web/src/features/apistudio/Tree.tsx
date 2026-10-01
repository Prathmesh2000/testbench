'use client';

import type { ApiNode, ApiNodeDetail } from '@tb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { api, ApiError } from '@/lib/api';
import { METHOD_SHORT, nestTree, pathTo, type TreeItem } from './model';
import { exportNode } from './Transfer';
import s from './apistudio.module.css';

interface Props {
  base: string;
  workspaceId: string;
  nodes: ApiNode[];
  selectedId: string | null;
  onSelect(id: string): void;
  canEdit: boolean;
}

/** Collections, folders and requests. Folders around the selected request open by themselves. */
export function Tree({ base, workspaceId, nodes, selectedId, onSelect, canEdit }: Props) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const tree = useMemo(() => nestTree(nodes), [nodes]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // The row menu closes on any click elsewhere and on Escape.
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', key);
    };
  }, [menuFor]);

  useEffect(() => {
    if (!selectedId) return;
    const path = pathTo(nodes, selectedId);
    setOpen((o) => (path.every((id) => o.has(id)) ? o : new Set([...o, ...path])));
  }, [selectedId, nodes]);

  const toggle = (id: string) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['apitest', 'tree', workspaceId] });

  const add = async (kind: 'folder' | 'request', parentId: string) => {
    const name = window.prompt(kind === 'folder' ? 'Folder name' : 'Request name', kind === 'folder' ? 'New folder' : 'New request');
    if (!name?.trim()) return;
    try {
      const node = await api<ApiNodeDetail>('POST', `${base}/nodes`, { kind, name: name.trim(), parentId });
      setOpen((o) => new Set([...o, parentId]));
      await refresh();
      onSelect(node.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not create it', 'bad');
    }
  };
  const rename = async (n: ApiNode) => {
    const name = window.prompt('Rename', n.name);
    if (!name?.trim() || name === n.name) return;
    await api('PATCH', `${base}/nodes/${n.id}`, { name: name.trim() }).catch((err) => notify(err instanceof ApiError ? err.message : 'Could not rename', 'bad'));
    refresh();
  };
  const duplicate = async (n: ApiNode) => {
    try {
      const copy = await api<ApiNodeDetail>('POST', `${base}/nodes/${n.id}/duplicate`);
      await refresh();
      onSelect(copy.id);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : 'Could not duplicate', 'bad');
    }
  };
  const download = (n: ApiNode) => exportNode(base, n).catch((err) => notify(err instanceof ApiError ? err.message : 'Could not export', 'bad'));
  const remove = async (n: ApiNode) => {
    const what = n.kind === 'request' ? 'request and its variations' : `${n.kind} and everything in it`;
    if (!window.confirm(`Delete "${n.name}"? This deletes the ${what}.`)) return;
    await api('DELETE', `${base}/nodes/${n.id}`).catch((err) => notify(err instanceof ApiError ? err.message : 'Could not delete', 'bad'));
    refresh();
  };

  const render = (item: TreeItem, depth: number): React.ReactNode => {
    const isOpen = open.has(item.id);
    const container = item.kind !== 'request';
    return (
      <div key={item.id} role="treeitem" aria-expanded={container ? isOpen : undefined} aria-selected={selectedId === item.id}>
        <div
          className={`${s.row} ${selectedId === item.id ? s.on : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          tabIndex={0}
          onClick={() => {
            if (container) toggle(item.id);
            onSelect(item.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (container) toggle(item.id);
              onSelect(item.id);
            } else if (container && e.key === 'ArrowRight' && !isOpen) toggle(item.id);
            else if (container && e.key === 'ArrowLeft' && isOpen) toggle(item.id);
          }}
        >
          <span className={s.twist}>{container ? <Icon name={isOpen ? 'collapse' : 'expand'} size={12} /> : null}</span>
          {item.kind === 'request' ? (
            <span className={`${s.method} ${s[`m-${item.method}`]}`}>{METHOD_SHORT[item.method ?? 'GET']}</span>
          ) : (
            <Icon name={item.kind === 'collection' ? 'layers' : 'tree'} size={13} />
          )}
          <span className="trunc">{item.name}</span>
          {item.needsReview && <span className={s.fail} title={`Needs review: ${item.needsReview}`} aria-label="Needs review"><Icon name="alert" size={12} /></span>}
          {item.variationCount > 0 && <span className={s.count} title={`${item.variationCount} variations`}>+{item.variationCount}</span>}
          {canEdit && (
            <span className={s.actions} onClick={(e) => e.stopPropagation()}>
              {container && <button className="btn ghost sm" aria-label={`New request in ${item.name}`} title="New request" onClick={() => add('request', item.id)}><Icon name="plus" size={12} /></button>}
              {container && <button className="btn ghost sm" aria-label={`New folder in ${item.name}`} title="New folder" onClick={() => add('folder', item.id)}><Icon name="tree" size={12} /></button>}
              <button
                className="btn ghost sm"
                aria-label={`More actions for ${item.name}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === item.id}
                title="More"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === item.id ? null : item.id);
                }}
              >
                ⋯
              </button>
            </span>
          )}
          {menuFor === item.id && (
            <div className="menu" role="menu" style={{ right: 8, top: 26 }} onClick={(e) => e.stopPropagation()}>
              {([
                ['Rename', 'edit', () => rename(item)],
                ['Duplicate', 'layers', () => duplicate(item)],
                ['Export as Postman', 'forward', () => download(item)],
                ['Delete', 'x', () => remove(item)],
              ] as const).map(([label, icon, run]) => (
                <button key={label} className="mi" role="menuitem" onClick={() => { setMenuFor(null); void run(); }}><Icon name={icon} size={13} />{label}</button>
              ))}
            </div>
          )}
        </div>
        {container && isOpen && (
          <div role="group">
            {item.children.map((c) => render(c, depth + 1))}
            {item.children.length === 0 && <div className="t3" style={{ paddingLeft: 36 + depth * 14, fontSize: 12, height: 26, display: 'flex', alignItems: 'center' }}>Empty</div>}
          </div>
        )}
      </div>
    );
  };

  return <div role="tree" aria-label="Collections">{tree.map((t) => render(t, 0))}</div>;
}

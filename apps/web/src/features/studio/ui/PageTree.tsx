'use client';

import { UI_KINDS, UI_RULES, UI_SEVERITIES, type UiIssue, type UiKind, type UiNode, type UiSeverity } from '@tb/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import type { TreeIndex } from './audit';
import s from './ui.module.css';

interface Row {
  node: UiNode;
  level: number;
  hasKids: boolean;
}

/** The worst severity among an element's issues, for its badge. */
function worst(list: UiIssue[] | undefined): UiSeverity | null {
  if (!list?.length) return null;
  return UI_SEVERITIES.find((sev) => list.some((i) => UI_RULES[i.rule].severity === sev)) ?? null;
}

/**
 * The page as a tree of elements, like the DevTools Elements panel but by what things are (button,
 * heading, field) rather than raw tags. Hovering a row outlines the element in the page; choosing one
 * selects it. Opens two levels deep; a search or filter shows matches as a flat list instead.
 */
export function PageTree({
  tree,
  issuesByNode,
  selected,
  onSelect,
  onHover,
}: {
  tree: TreeIndex;
  issuesByNode: Map<number, UiIssue[]>;
  selected: number | null;
  onSelect(id: number): void;
  onHover(id: number | null): void;
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<UiKind | ''>('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // A new scan opens the top two levels.
  useEffect(() => {
    const next = new Set<number>();
    const walk = (nodes: UiNode[], level: number) => {
      for (const n of nodes) {
        if (level < 2 && tree.children.has(n.id)) {
          next.add(n.id);
          walk(tree.children.get(n.id)!, level + 1);
        }
      }
    };
    walk(tree.roots, 0);
    setOpen(next);
  }, [tree]);

  // Selecting from the page or a suggestion opens the way down to it and brings it into view.
  useEffect(() => {
    if (selected === null) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (let p = tree.byId.get(selected)?.parent ?? null; p !== null; p = tree.byId.get(p)?.parent ?? null) next.add(p);
      return next;
    });
    requestAnimationFrame(() => list.current?.querySelector(`[data-node="${selected}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [selected, tree]);

  const filtering = query.trim() !== '' || kind !== '' || issuesOnly;
  const rows = useMemo<Row[]>(() => {
    if (filtering) {
      const q = query.trim().toLowerCase();
      return [...tree.byId.values()]
        .filter((n) => (!kind || n.kind === kind) && (!issuesOnly || issuesByNode.has(n.id)))
        .filter((n) => !q || `${n.tag} ${n.name} ${n.text} ${n.selector}`.toLowerCase().includes(q))
        .slice(0, 500)
        .map((node) => ({ node, level: 0, hasKids: false }));
    }
    const out: Row[] = [];
    const walk = (nodes: UiNode[], level: number) => {
      for (const node of nodes) {
        const kids = tree.children.get(node.id);
        out.push({ node, level, hasKids: !!kids?.length });
        if (kids && open.has(node.id)) walk(kids, level + 1);
      }
    };
    walk(tree.roots, 0);
    return out;
  }, [tree, open, filtering, query, kind, issuesOnly, issuesByNode]);

  const toggle = (id: number, on?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKey = (e: React.KeyboardEvent) => {
    const at = rows.findIndex((r) => r.node.id === selected);
    const row = rows[at];
    const move = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (r) onSelect(r.node.id);
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'ArrowRight' && row?.hasKids) toggle(row.node.id, true);
    else if (e.key === 'ArrowLeft' && row) {
      if (row.hasKids && open.has(row.node.id)) toggle(row.node.id, false);
      else if (row.node.parent !== null) onSelect(row.node.parent);
    } else return;
    e.preventDefault();
  };

  return (
    <div className={s.treeWrap}>
      <div className={s.treeTools}>
        <input className="inp f1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find by text, tag or selector" aria-label="Find in the page tree" />
        <select className="inp" value={kind} onChange={(e) => setKind(e.target.value as UiKind | '')} aria-label="Show one kind of element">
          <option value="">All kinds</option>
          {UI_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button className={`chip ${issuesOnly ? 'on' : ''}`} aria-pressed={issuesOnly} onClick={() => setIssuesOnly((v) => !v)}>
          <Icon name="alert" size={11} />Issues
        </button>
      </div>
      <div
        ref={list}
        className={s.tree}
        role="tree"
        aria-label="Page elements"
        tabIndex={0}
        onKeyDown={onKey}
        onMouseLeave={() => onHover(null)}
      >
        {rows.length === 0 && <div className="t3" style={{ padding: 12, fontSize: 12 }}>{filtering ? 'Nothing matches.' : 'The page has no elements to show.'}</div>}
        {rows.map(({ node, level, hasKids }) => {
          const issues = issuesByNode.get(node.id);
          const sev = worst(issues);
          return (
            <div
              key={node.id}
              data-node={node.id}
              role="treeitem"
              aria-level={level + 1}
              aria-expanded={hasKids ? open.has(node.id) : undefined}
              aria-selected={node.id === selected}
              className={`${s.treeRow} ${node.id === selected ? s.on : ''}`}
              style={{ paddingLeft: 6 + level * 14 }}
              onMouseEnter={() => onHover(node.id)}
              onClick={() => onSelect(node.id)}
            >
              {hasKids ? (
                <button
                  className={s.caret}
                  tabIndex={-1}
                  aria-label={open.has(node.id) ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(node.id);
                  }}
                >
                  <Icon name={open.has(node.id) ? 'chevDown' : 'chevRight'} size={10} />
                </button>
              ) : (
                <span className={s.caret} aria-hidden />
              )}
              <span className={`${s.tag} ${s[`k_${node.kind}`] ?? ''}`}>{node.tag}</span>
              {node.kind !== 'container' && node.kind !== 'text' && <span className={s.kindChip}>{node.kind}</span>}
              <span className="trunc f1">{node.name || node.text || <span className="t3">{node.selector.split(' > ').pop()}</span>}</span>
              {sev && (
                <span className={`${s.badge} ${s[sev]}`} title={issues!.map((i) => UI_RULES[i.rule].title).join('\n')}>
                  {issues!.length}
                </span>
              )}
              <span className={s.dims}>{node.box.w}×{node.box.h}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import type * as Y from 'yjs';
import { cellKey, cellRef, colName } from './boards-utils';
import { useYVersion } from './collab';
import s from './boards.module.css';

// Univer's live collaboration needs its paid server, so sheets are a plain grid over two Yjs maps:
// `cells` ("row:col" → text) and `meta` (rows, cols). No formulas.

const DEFAULT_ROWS = 50;
const DEFAULT_COLS = 12;
const ROW_H = 30;
const COL_W = 168;
const RN_W = 40;

/** Collaborative grid: arrows/Tab move, Enter or typing edits, Delete clears. */
export function SheetEditor({ doc, canEdit }: { doc: Y.Doc; canEdit: boolean }) {
  const cells = doc.getMap<string>('cells');
  const meta = doc.getMap<number>('meta');
  useYVersion(cells);
  useYVersion(meta);
  const rows = meta.get('rows') ?? DEFAULT_ROWS;
  const cols = meta.get('cols') ?? DEFAULT_COLS;

  const [sel, setSel] = useState({ r: 0, c: 0 });
  const [draft, setDraft] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Escape moves focus back to the grid, and the input's blur would otherwise save the draft it discards.
  const cancelling = useRef(false);
  const virtualizer = useVirtualizer({ count: rows, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 12 });

  const valueAt = (r: number, c: number) => cells.get(cellKey(r, c)) ?? '';
  const write = (r: number, c: number, value: string) => {
    if (!canEdit || value === valueAt(r, c)) return;
    doc.transact(() => (value ? cells.set(cellKey(r, c), value) : cells.delete(cellKey(r, c))));
  };

  const moveTo = (r: number, c: number) => {
    const next = { r: Math.max(0, Math.min(rows - 1, r)), c: Math.max(0, Math.min(cols - 1, c)) };
    setSel(next);
    virtualizer.scrollToIndex(next.r, { align: 'auto' });
    // Rows are virtualised by the library; columns are few, so horizontal scrolling is done by hand.
    const el = scrollRef.current;
    if (el) {
      const left = RN_W + next.c * COL_W;
      if (left - RN_W < el.scrollLeft) el.scrollLeft = left - RN_W;
      else if (left + COL_W > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COL_W - el.clientWidth;
    }
  };

  const startEdit = (initial?: string) => {
    if (canEdit) setDraft(initial ?? valueAt(sel.r, sel.c));
  };
  const commit = (dr: number, dc: number) => {
    if (draft !== null) write(sel.r, sel.c, draft);
    setDraft(null);
    moveTo(sel.r + dr, sel.c + dc);
    gridRef.current?.focus();
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (draft !== null) return;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    // Tab stays inside the grid except at its edge, so keyboard users can still leave it.
    const tabOut = e.key === 'Tab' && (e.shiftKey ? sel.c === 0 : sel.c === cols - 1);
    const move = moves[e.key] ?? (e.key === 'Tab' && !tabOut ? [0, e.shiftKey ? -1 : 1] : undefined);
    if (move) {
      e.preventDefault();
      moveTo(sel.r + move[0], sel.c + move[1]);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      write(sel.r, sel.c, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Typing over a selected cell replaces its value, as in any spreadsheet.
      e.preventDefault();
      startEdit(e.key);
    }
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit(0, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelling.current = true;
      setDraft(null);
      gridRef.current?.focus();
    }
  };

  const addRow = () => doc.transact(() => meta.set('rows', rows + 1));
  const addCol = () => doc.transact(() => meta.set('cols', cols + 1));
  const colList = Array.from({ length: cols }, (_, c) => c);

  return (
    <div className="f1" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className={s.fbar}>
        <span className="mono t2" style={{ width: 44 }}>{cellRef(sel.r, sel.c)}</span>
        <label className="t3" htmlFor="sheet-fx">fx</label>
        <input
          id="sheet-fx"
          className="inp f1"
          style={{ height: 26 }}
          value={draft ?? valueAt(sel.r, sel.c)}
          readOnly={!canEdit}
          onChange={(e) => (draft === null ? write(sel.r, sel.c, e.target.value) : setDraft(e.target.value))}
        />
        {canEdit && <button className="btn sm" onClick={addRow}>Add row</button>}
        {canEdit && <button className="btn sm" onClick={addCol}>Add column</button>}
      </div>
      <div ref={scrollRef} className={s.sheetScroll}>
        <div
          ref={gridRef}
          className={s.sg}
          style={{ width: RN_W + cols * COL_W }}
          role="grid"
          aria-label="Sheet"
          aria-rowcount={rows}
          aria-colcount={cols}
          tabIndex={0}
          onKeyDown={onGridKey}
        >
          <div className={`${s.sr} ${s.sh}`} role="row">
            <div className={s.rn} />
            {colList.map((c) => <div key={c} role="columnheader" className={`${s.sc} ${c === sel.c ? s.hdrOn : ''}`}>{colName(c)}</div>)}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div key={v.key} className={s.sr} role="row" aria-rowindex={v.index + 1} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}>
                <div className={`${s.rn} ${v.index === sel.r ? s.hdrOn : ''}`} role="rowheader">{v.index + 1}</div>
                {colList.map((c) => {
                  const selected = v.index === sel.r && c === sel.c;
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      aria-selected={selected}
                      className={`${s.sc} ${selected ? s.sel : ''}`}
                      onMouseDown={() => {
                        if (selected) return startEdit();
                        if (draft !== null) write(sel.r, sel.c, draft);
                        setDraft(null);
                        setSel({ r: v.index, c });
                      }}
                      onDoubleClick={() => startEdit()}
                    >
                      {selected && draft !== null ? (
                        <input
                          className={s.cellInput}
                          autoFocus
                          aria-label={cellRef(v.index, c)}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={onInputKey}
                          onBlur={() => {
                            if (!cancelling.current) write(sel.r, sel.c, draft);
                            cancelling.current = false;
                            setDraft(null);
                          }}
                        />
                      ) : (
                        <span className="trunc">{valueAt(v.index, c)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

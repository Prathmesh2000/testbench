'use client';

import { useRef, useState } from 'react';
import s from './ide.module.css';

/**
 * A size remembered in this browser, such as a pane's width. Falls back to the default when storage
 * is unavailable (private browsing) or holds something that is not a number.
 */
export function useStoredSize(key: string, fallback: number): [number, (v: number) => void] {
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const save = (v: number) => {
    setSize(v);
    try {
      localStorage.setItem(key, String(Math.round(v)));
    } catch {
      // Not remembered; the pane still resizes.
    }
  };
  return [size, save];
}

/** An on/off choice remembered in this browser, such as a collapsed panel. */
export function useStoredFlag(key: string, fallback: boolean): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === '1';
    } catch {
      return fallback;
    }
  });
  const save = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      // Not remembered; the panel still collapses.
    }
  };
  return [on, save];
}

/**
 * A draggable divider that sets the size of the pane after it (to its right, or below it), so
 * dragging towards that pane shrinks it. Arrow keys move it too, for people not using a mouse.
 */
export function Splitter({
  direction,
  size,
  min,
  max,
  onResize,
  label,
}: {
  /** `columns`: a vertical bar between side-by-side panes; `rows`: a horizontal bar between stacked ones. */
  direction: 'columns' | 'rows';
  size: number;
  min: number;
  max: number;
  onResize(size: number): void;
  label: string;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const clamp = (v: number) => Math.min(Math.max(v, min), Math.max(min, max));
  const pos = (e: { clientX: number; clientY: number }) => (direction === 'columns' ? e.clientX : e.clientY);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={direction === 'columns' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      className={direction === 'columns' ? s.splitCols : s.splitRows}
      onPointerDown={(e) => {
        e.preventDefault();
        // Captured, so dragging across the streamed page or the editor keeps resizing.
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { at: pos(e), size };
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(clamp(start.current.size - (pos(e) - start.current.at)));
      }}
      onPointerUp={() => (start.current = null)}
      onKeyDown={(e) => {
        const back = direction === 'columns' ? 'ArrowLeft' : 'ArrowUp';
        const forward = direction === 'columns' ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== forward) return;
        e.preventDefault();
        onResize(clamp(size + (e.key === back ? 24 : -24)));
      }}
    />
  );
}

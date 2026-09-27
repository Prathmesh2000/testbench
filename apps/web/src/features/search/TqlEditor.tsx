'use client';

import { highlight, parse, suggest, TqlError, type Suggestion } from '@tb/tql';
import { useMemo, useRef, useState } from 'react';
import s from './search.module.css';

interface Props {
  value: string;
  onChange(value: string): void;
  onRun(): void;
  /** Project values the parser cannot know (labels, owners, types), for autocomplete. */
  values: Record<string, readonly string[]>;
  /** A problem reported by the server, e.g. an unknown owner, shown until the query changes. */
  serverError?: { message: string; start?: number; end?: number } | null;
}

const CLASS = { kw: s.kw, field: s.fd, op: s.op, str: s.sv, num: s.sv, text: undefined } as const;

/**
 * TQL editor: a transparent textarea over a highlighted copy of the same text, so typing feels native
 * while keywords, fields and values are coloured. Parses on every keystroke with the same parser the
 * API uses, so a mistake is underlined before the query is ever sent.
 */
export function TqlEditor({ value, onChange, onRun, values, serverError }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);

  const problem = useMemo(() => {
    try {
      parse(value);
      return null;
    } catch (err) {
      return err instanceof TqlError ? { message: err.message, start: err.start, end: err.end } : null;
    }
  }, [value]);
  // A problem at the very end just means "not finished typing" (e.g. `lastResult = `): stay quiet
  // while the autocomplete helps finish it, instead of flashing an error on every keystroke.
  const unfinished = !!problem && problem.start >= value.trimEnd().length;
  const shown = (unfinished ? null : problem) ?? serverError ?? null;

  const suggestions = useMemo(() => (open ? suggest(value, cursor, values) : null), [open, value, cursor, values]);
  const items = suggestions?.items ?? [];

  // Highlighted copy, with the error range underlined on top of the normal colours.
  const spans = useMemo(() => {
    const out: React.ReactNode[] = [];
    let at = 0;
    const bad = shown && shown.start !== undefined ? { start: shown.start, end: Math.max(shown.end ?? shown.start, shown.start + 1) } : null;
    for (const t of highlight(value)) {
      if (t.start > at) out.push(<span key={`g${at}`}>{value.slice(at, t.start)}</span>);
      const isBad = bad && t.start < bad.end && t.end > bad.start;
      out.push(<span key={t.start} className={`${CLASS[t.cls] ?? ''} ${isBad ? s.bad : ''}`}>{value.slice(t.start, t.end)}</span>);
      at = t.end;
    }
    if (at < value.length) out.push(<span key={`g${at}`} className={bad && bad.start >= at ? s.bad : undefined}>{value.slice(at)}</span>);
    return out;
  }, [value, shown]);

  const accept = (item: Suggestion) => {
    if (!suggestions) return;
    const next = value.slice(0, suggestions.from) + item.insert + value.slice(suggestions.to);
    const caret = suggestions.from + item.insert.length;
    onChange(next);
    setCursor(caret);
    setSelected(0);
    requestAnimationFrame(() => area.current?.setSelectionRange(caret, caret));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => (i + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => (i - 1 + items.length) % items.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey)) { e.preventDefault(); accept(items[selected] ?? items[0]!); return; }
    }
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setOpen(false); onRun(); }
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className={`${s.ed} ${shown ? s.err : ''}`}>
        <pre className={s.edl} aria-hidden="true">{spans} </pre>
        <textarea
          ref={area} className={s.edt} value={value} spellCheck={false} aria-label="TQL query" aria-invalid={!!shown}
          placeholder="label = smoke AND lastResult = Failed"
          onChange={(e) => { onChange(e.target.value); setCursor(e.target.selectionStart); setOpen(true); setSelected(0); }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => setCursor(e.currentTarget.selectionStart)}
          onClick={(e) => { setCursor(e.currentTarget.selectionStart); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && items.length > 0 && (
          <div className={s.ac} role="listbox" aria-label="Suggestions">
            <div className="t3" style={{ fontSize: 11, padding: '4px 8px' }}>{items[0]!.kind === 'value' ? 'Values' : items[0]!.kind === 'operator' ? 'Operators' : items[0]!.kind === 'field' ? 'Fields' : 'Continue with'} · <span className="kbd">Tab</span> to accept</div>
            {items.map((item, i) => (
              <button
                key={`${item.kind}-${item.label}`} role="option" aria-selected={i === selected} className={`${s.aci} ${i === selected ? s.on : ''}`}
                onMouseDown={(e) => { e.preventDefault(); accept(item); }}
              >
                <span className="mono">{item.label}</span>
                {item.detail && <span className={s.ty}>{item.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {shown && (
        <div className="banner bad" role="alert">
          <span className="f1">{shown.message}</span>
        </div>
      )}
    </div>
  );
}

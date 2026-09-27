'use client';

import { useState } from 'react';
import { Icon } from '@/components/Icon';

interface Option {
  value: string;
  label: string;
}

/** A filter chip that opens a multi-select menu. Shows how many values are active. */
export function FilterMenu({ label, options, value, onChange }: { label: string; options: Option[]; value: string[]; onChange(v: string[]): void }) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  const summary = value.length === 1 ? options.find((o) => o.value === value[0])?.label : value.length > 1 ? `${value.length}` : null;
  return (
    <span style={{ position: 'relative' }}>
      <button className={`chip ${value.length ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        {label}{summary && <b style={{ fontWeight: 500 }}>: {summary}</b>}
        <Icon name="chevDown" size={11} />
      </button>
      {open && (
        <>
          <div className="scrim" style={{ background: 'transparent' }} onClick={() => setOpen(false)} />
          <div className="menu" style={{ top: 28, left: 0, zIndex: 52 }} role="menu">
            {options.map((o) => (
              <label key={o.value} className="mi" role="menuitemcheckbox" aria-checked={value.includes(o.value)}>
                <input type="checkbox" className="cb" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                {o.label}
              </label>
            ))}
            {value.length > 0 && <button className="mi t3" onClick={() => onChange([])}>Clear</button>}
          </div>
        </>
      )}
    </span>
  );
}

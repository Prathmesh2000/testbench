'use client';

import { Icon } from './Icon';

const GROUPS: { title: string; keys: [string, string[]][] }[] = [
  { title: 'Global', keys: [
    ['Command palette', ['Ctrl', 'K']], ['Search', ['/']], ['Shortcuts', ['?']], ['Go home', ['g', 'h']],
    ['Go to test cases', ['g', 'c']], ['Go to runs', ['g', 'r']], ['Search page', ['g', 's']], ['Defects', ['g', 'd']], ['New run', ['g', 'n']], ['Close', ['Esc']],
  ] },
  { title: 'Test cases', keys: [
    ['Next / previous row', ['J', 'K']], ['Open in drawer', ['Enter']], ['Open full page', ['O']], ['Select row', ['X']],
  ] },
  { title: 'Execute', keys: [
    ['Pass / Fail', ['P', 'F']], ['Blocked / Skip', ['B', 'S']], ['Pass all remaining', ['⇧', 'P']], ['Next / previous step', ['↓', '↑']],
    ['Next case', ['J']], ['Previous case', ['K']], ['Log bug', ['Ctrl', '⇧', 'B']],
  ] },
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal center keys" role="dialog" aria-label="Keyboard shortcuts">
        <div className="row" style={{ height: 48, padding: '0 12px 0 20px', borderBottom: '1px solid var(--border)' }}>
          <span className="cond" style={{ fontSize: 16, fontWeight: 600 }}>Keyboard shortcuts</span>
          <span className="t3" style={{ fontSize: 12 }}>Every main action has one</span>
          <div className="f1" />
          <button className="ib" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="kgrid">
          {GROUPS.map((g) => (
            <div key={g.title} className="col">
              <div className="kh">{g.title}</div>
              {g.keys.map(([label, keys]) => (
                <div key={label} className="krow">
                  <span>{label}</span>
                  <span>{keys.map((k) => <span key={k} className="kbd">{k}</span>)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

'use client';

import { UI_RULES, UI_SEVERITIES, type UiIssue, type UiRule, type UiScan, type UiSeverity } from '@tb/contracts';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { bytes, fmt } from '@/lib/format';
import { CHECKS, grade, VITALS, type CheckResult, type Count, type Finding, type FindingSeverity, type Grade, type RuleSuggestion, type UiStats } from './audit';
import s from './ui.module.css';

const GRADE_LABEL: Record<Grade, string> = { good: 'Good', 'needs-work': 'Needs work', poor: 'Poor' };
const GRADE_ICON = { good: 'check', 'needs-work': 'alert', poor: 'x' } as const;

function GradeTag({ g }: { g: Grade | null }) {
  if (!g) return <span className="t3">n/a</span>;
  return <span className={`${s.grade} ${s[`g_${g}`]}`}><Icon name={GRADE_ICON[g]} size={10} />{GRADE_LABEL[g]}</span>;
}

function Tile({ label, value, sub, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={s.tile}>
      <span className={s.tileLabel}>{label}</span>
      <span className={s.tileValue}>{value}</span>
      {sub && <span className={s.tileSub}>{sub}</span>}
      {children}
    </div>
  );
}

/** One measure across categories, largest first: a label, a bar in proportion and the count. */
function Bars({ rows, label, render, max = 12 }: { rows: Count[]; label: string; render?(value: string): React.ReactNode; max?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, max);
  const top = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return <div className="t3" style={{ fontSize: 12 }}>None on this page.</div>;
  return (
    <>
      <ul className={s.bars} aria-label={label}>
        {shown.map((r) => (
          <li key={r.value} title={`${r.value}: ${r.count}`}>
            <span className={`${s.barLabel} trunc`}>{render ? render(r.value) : r.value}</span>
            <span className={s.barTrack}><span className={s.barFill} style={{ width: `${(r.count / top) * 100}%` }} /></span>
            <span className={s.barValue}>{fmt(r.count)}</span>
          </li>
        ))}
      </ul>
      {rows.length > max && <button className="btn sm ghost" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </>
  );
}

const swatch = (hex: string) => (
  <span className="row" style={{ gap: 6 }}><span className={s.swatch} style={{ background: hex }} aria-hidden /><span className="mono">{hex}</span></span>
);

// ---------- stats ----------

export function StatsPanel({ scan, stats }: { scan: UiScan; stats: UiStats }) {
  return (
    <div className={s.panelBody}>
      <div className={s.tiles}>
        <Tile label="Elements" value={fmt(stats.elements)} sub={scan.truncated ? 'first 2,500 only' : `${fmt(scan.perf.domNodes)} in the DOM`} />
        <Tile label="With text" value={fmt(stats.textElements)} />
        <Tile label="Interactive" value={fmt(stats.interactive)} sub="reachable by keyboard" />
        <Tile label="Accessibility" value={`${stats.a11yScore}/100`} sub={`${scan.issues.length} issues`} />
      </div>
      <div className={s.tiles}>
        <Tile label="Font families" value={stats.fonts.length} />
        <Tile label="Font sizes" value={stats.sizes.length} sub={stats.nearSizes.length ? `${stats.nearSizes.length} near-duplicates` : undefined} />
        <Tile label="Text colours" value={stats.colours.length} sub={stats.nearColours.length ? `${stats.nearColours.length} near-duplicates` : undefined} />
        <Tile label="Corner radii" value={stats.radii.length} />
      </div>
      <h4 className={s.h4}>Elements by kind</h4>
      <Bars rows={stats.kinds} label="Elements by kind" />
      <h4 className={s.h4}>Font families <span className="t3">(text elements)</span></h4>
      <Bars rows={stats.fonts} label="Font families" />
      <h4 className={s.h4}>Font sizes</h4>
      <Bars rows={stats.sizes} label="Font sizes" render={(v) => <span className="mono">{v}px</span>} max={16} />
      <h4 className={s.h4}>Font weights</h4>
      <Bars rows={stats.weights} label="Font weights" render={(v) => <span className="mono">{v}</span>} />
      <h4 className={s.h4}>Text colours</h4>
      <Bars rows={stats.colours} label="Text colours" render={swatch} />
      <h4 className={s.h4}>Backgrounds behind text</h4>
      <Bars rows={stats.backgrounds} label="Backgrounds behind text" render={swatch} />
      <h4 className={s.h4}>Corner radii</h4>
      <Bars rows={stats.radii} label="Corner radii" render={(v) => <span className="mono">{v}</span>} />
    </div>
  );
}

// ---------- accessibility ----------

export function A11yPanel({ scan, stats, onShow }: { scan: UiScan; stats: UiStats; onShow(node: number): void }) {
  const groups = useMemo(() => {
    const m = new Map<UiRule, UiIssue[]>();
    for (const i of scan.issues) m.set(i.rule, [...(m.get(i.rule) ?? []), i]);
    const rank = (r: UiRule) => UI_SEVERITIES.indexOf(UI_RULES[r].severity);
    return [...m].sort(([a], [b]) => rank(a) - rank(b));
  }, [scan]);
  const bySeverity = (sev: UiSeverity) => scan.issues.filter((i) => UI_RULES[i.rule].severity === sev).length;
  const [open, setOpen] = useState<UiRule | null>(null);

  return (
    <div className={s.panelBody}>
      <div className={s.tiles}>
        <Tile label="Score" value={`${stats.a11yScore}/100`} sub="Testbench’s rules, not Lighthouse" />
        {UI_SEVERITIES.map((sev) => (
          <Tile key={sev} label={sev[0]!.toUpperCase() + sev.slice(1)} value={<span className={bySeverity(sev) ? s[sev] : undefined}>{bySeverity(sev)}</span>} />
        ))}
      </div>
      {groups.length === 0 ? (
        <div className={s.allClear}><Icon name="check" size={14} />None of the {Object.keys(UI_RULES).length} automatic checks found a problem. Check keyboard use, focus and zoom by hand: they are on the checklist.</div>
      ) : (
        <ul className={s.ruleList}>
          {groups.map(([rule, list]) => {
            const r = UI_RULES[rule];
            return (
              <li key={rule} className={s.rule}>
                <button className={s.ruleHead} aria-expanded={open === rule} onClick={() => setOpen(open === rule ? null : rule)}>
                  <Icon name={open === rule ? 'chevDown' : 'chevRight'} size={10} />
                  <span className={`${s.sev} ${s[r.severity]}`}>{r.severity}</span>
                  <span className="f1 trunc">{r.title}</span>
                  <span className="mono t3">WCAG {r.wcag}</span>
                  <span className={s.count}>{list.length}</span>
                </button>
                {open === rule && (
                  <ul className={s.ruleItems}>
                    {list.slice(0, 100).map((i, n) => (
                      <li key={n}>
                        <span className="f1">{i.message}</span>
                        {i.node !== null && <button className="btn sm" onClick={() => onShow(i.node!)}>Show</button>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- performance ----------

const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${fmt(v)} ms`);

export function PerfPanel({ scan }: { scan: UiScan }) {
  const p = scan.perf;
  const name = (url: string) => {
    try {
      const u = new URL(url);
      return u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    } catch {
      return url;
    }
  };
  return (
    <div className={s.panelBody}>
      <div className={s.vitals}>
        {VITALS.map((v) => (
          <div key={v.key} className={s.vital} title={v.hint}>
            <span className={s.tileLabel}>{v.label}</span>
            <span className={s.tileValue}>{v.unit ? ms(p[v.key]) : (p[v.key] ?? '—')}</span>
            <GradeTag g={grade(v.key, p[v.key])} />
            <span className={s.tileSub}>{v.hint}</span>
          </div>
        ))}
      </div>
      <p className="t3" style={{ fontSize: 11.5, margin: 0 }}>
        Measured in the Test Browser on the server, from its own network: a lab reading, not what users see. Timings are for the
        last full page load; after in-app navigation, reload the page for fresh numbers. LCP stops updating once you interact.
      </p>
      <div className={s.tiles}>
        <Tile label="DOM ready" value={ms(p.domContentLoaded)} />
        <Tile label="Loaded" value={ms(p.load)} />
        <Tile label="Requests" value={fmt(p.requests)} sub={bytes(p.bytes)} />
        <Tile label="DOM" value={fmt(p.domNodes)} sub={`depth ${p.domDepth}`} />
        {p.jsHeapMb !== null && <Tile label="JS heap" value={`${p.jsHeapMb} MB`} />}
      </div>
      <h4 className={s.h4}>Transfer by type</h4>
      {p.byType.length ? (
        <ul className={s.bars} aria-label="Transfer size by type">
          {p.byType.map((t) => (
            <li key={t.type} title={`${t.type}: ${t.count} files, ${bytes(t.bytes)}`}>
              <span className={s.barLabel}>{t.type} <span className="t3">×{t.count}</span></span>
              <span className={s.barTrack}><span className={s.barFill} style={{ width: `${(t.bytes / Math.max(1, ...p.byType.map((x) => x.bytes))) * 100}%` }} /></span>
              <span className={s.barValue}>{bytes(t.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="t3" style={{ fontSize: 12 }}>No files besides the page itself.</div>
      )}
      {(['largest', 'slowest'] as const).map((k) =>
        p[k].length ? (
          <div key={k}>
            <h4 className={s.h4}>{k === 'largest' ? 'Largest files' : 'Slowest files'}</h4>
            <table className={s.table}>
              <thead><tr><th>File</th><th>Type</th><th className={s.num}>Size</th><th className={s.num}>Time</th></tr></thead>
              <tbody>
                {p[k].map((r, i) => (
                  <tr key={i}>
                    <td className="trunc" title={r.url} style={{ maxWidth: 220 }}>{name(r.url)}</td>
                    <td>{r.type}</td>
                    <td className={s.num}>{bytes(r.bytes)}</td>
                    <td className={s.num}>{ms(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null,
      )}
    </div>
  );
}

// ---------- the tester's review ----------

const SEVERITIES: FindingSeverity[] = ['high', 'medium', 'low'];

export function ChecksPanel({
  checks,
  notes,
  findings,
  selectedLabel,
  onCheck,
  onNote,
  onAddFinding,
  onRemoveFinding,
  onShow,
}: {
  checks: Record<string, CheckResult>;
  notes: Record<string, string>;
  findings: Finding[];
  /** The element selected in the tree, which a new finding is attached to. */
  selectedLabel: string | null;
  onCheck(id: string, r: CheckResult): void;
  onNote(id: string, note: string): void;
  onAddFinding(f: Omit<Finding, 'id' | 'node' | 'element'>, attach: boolean): void;
  onRemoveFinding(id: string): void;
  onShow(node: number): void;
}) {
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<FindingSeverity>('medium');
  const [attach, setAttach] = useState(true);
  const done = CHECKS.filter((c) => checks[c.id]).length;
  const failed = CHECKS.filter((c) => checks[c.id] === 'fail').length;
  const groups = [...new Set(CHECKS.map((c) => c.group))];

  return (
    <div className={s.panelBody}>
      <h4 className={s.h4}>Findings <span className="t3">({findings.length})</span></h4>
      <form
        className={s.findingForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          onAddFinding({ title: title.trim(), note: note.trim(), severity }, attach && !!selectedLabel);
          setTitle('');
          setNote('');
        }}
      >
        <div className="row" style={{ gap: 6 }}>
          <input className="inp f1" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is wrong, e.g. Button text is 13px, design says 14px" aria-label="Finding" />
          <select className="inp" value={severity} onChange={(e) => setSeverity(e.target.value as FindingSeverity)} aria-label="Severity">
            {SEVERITIES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <textarea className={`inp ${s.note}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Expected, actual, where in the design (optional)" aria-label="Details" />
        <div className="row" style={{ gap: 6 }}>
          <label className="row t3" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={attach && !!selectedLabel} disabled={!selectedLabel} onChange={(e) => setAttach(e.target.checked)} />
            {selectedLabel ? <>On <code className="trunc" style={{ maxWidth: 200 }}>{selectedLabel}</code></> : 'Select an element to attach it'}
          </label>
          <span className="f1" />
          <button className="btn sm primary" type="submit" disabled={!title.trim()}><Icon name="plus" size={11} />Add finding</button>
        </div>
      </form>
      {findings.length > 0 && (
        <ul className={s.findings}>
          {findings.map((f) => (
            <li key={f.id}>
              <span className={`${s.sev} ${s[`f_${f.severity}`]}`}>{f.severity}</span>
              <div className="f1" style={{ minWidth: 0 }}>
                <div>{f.title}</div>
                {f.element && <code className="t3 trunc" style={{ display: 'block' }}>{f.element}</code>}
                {f.note && <div className="t3" style={{ whiteSpace: 'pre-wrap' }}>{f.note}</div>}
              </div>
              {f.node !== null && <button className="btn sm" onClick={() => onShow(f.node!)}>Show</button>}
              <button className="ib sm" aria-label={`Remove ${f.title}`} onClick={() => onRemoveFinding(f.id)}><Icon name="x" size={11} /></button>
            </li>
          ))}
        </ul>
      )}

      <h4 className={s.h4}>Checklist <span className="t3">({done}/{CHECKS.length} done{failed ? `, ${failed} failed` : ''})</span></h4>
      {groups.map((g) => (
        <fieldset key={g} className={s.checkGroup}>
          <legend>{g}</legend>
          {CHECKS.filter((c) => c.group === g).map((c) => (
            <div key={c.id} className={s.check}>
              <span className="f1">{c.label}</span>
              <div className="seg" role="radiogroup" aria-label={c.label}>
                {(['pass', 'fail', 'na'] as const).map((r) => (
                  <button key={r} role="radio" aria-checked={checks[c.id] === r} className={checks[c.id] === r ? `on ${s[`c_${r}`]}` : ''} onClick={() => onCheck(c.id, checks[c.id] === r ? null : r)}>
                    {r === 'pass' ? 'Pass' : r === 'fail' ? 'Fail' : 'N/A'}
                  </button>
                ))}
              </div>
              {checks[c.id] === 'fail' && (
                <input className={`inp ${s.checkNote}`} value={notes[c.id] ?? ''} onChange={(e) => onNote(c.id, e.target.value)} placeholder="What failed" aria-label={`What failed: ${c.label}`} />
              )}
            </div>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

// ---------- suggestions ----------

export function SuggestionsPanel({
  suggestions,
  ai,
  focus,
  onFocus,
  onAsk,
  asking,
  canAsk,
  onShow,
  onAdopt,
}: {
  suggestions: RuleSuggestion[];
  ai: { summary: string; status: 'used' | 'off' | 'unavailable'; message: string | null } | null;
  focus: string;
  onFocus(v: string): void;
  onAsk(): void;
  asking: boolean;
  canAsk: boolean;
  onShow(nodes: number[]): void;
  onAdopt(s: RuleSuggestion): void;
}) {
  const [area, setArea] = useState<string>('');
  const areas = [...new Set(suggestions.map((x) => x.area))];
  const shown = suggestions.filter((x) => !area || x.area === area);
  return (
    <div className={s.panelBody}>
      <div className={s.askBox}>
        <label htmlFor="ui-focus" className={s.h4} style={{ margin: 0 }}>Ask AI for a review</label>
        <div className="row" style={{ gap: 6 }}>
          <input id="ui-focus" className="inp f1" value={focus} onChange={(e) => onFocus(e.target.value)} placeholder="Optional focus: e.g. the checkout form, brand colours, mobile layout" />
          <button className="btn sm primary" onClick={onAsk} disabled={asking || !canAsk}>
            <Icon name="sparkle" size={11} />{asking ? 'Reviewing…' : 'Review with AI'}
          </button>
        </div>
        <span className="t3" style={{ fontSize: 11.5 }}>
          Sends the page’s measurements (fonts, colours, sizes, issues, timings), masked, never a screenshot or the whole page. Suggestions are drafts to check, not facts.
        </span>
        {ai && ai.status !== 'used' && <div className={s.aiNote} role="status"><Icon name="info" size={12} />{ai.message}</div>}
        {ai?.status === 'used' && ai.summary && (
          <div className={s.aiSummary}>
            <b><Icon name="sparkle" size={11} /> AI summary</b> <span className="t3">({ai.message})</span>
            <p>{ai.summary}</p>
          </div>
        )}
      </div>
      {areas.length > 1 && (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }} role="group" aria-label="Filter by area">
          <button className={`chip ${!area ? 'on' : ''}`} onClick={() => setArea('')}>All <span className="n">{suggestions.length}</span></button>
          {areas.map((a) => (
            <button key={a} className={`chip ${area === a ? 'on' : ''}`} onClick={() => setArea(a)}>{a} <span className="n">{suggestions.filter((x) => x.area === a).length}</span></button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <div className={s.allClear}><Icon name="check" size={14} />The numbers raise nothing. Ask AI for a second opinion, or compare with the design by hand.</div>
      ) : (
        <ul className={s.suggestions}>
          {shown.map((x, i) => (
            <li key={i}>
              <div className="row" style={{ gap: 6 }}>
                <span className={`${s.sev} ${s[`f_${x.severity}`]}`}>{x.severity}</span>
                <span className={s.kindChip}>{x.area}</span>
                {x.source === 'ai' && <span className={s.aiTag} title="Drafted by AI: check it before acting"><Icon name="sparkle" size={10} />AI</span>}
                <b className="f1">{x.title}</b>
              </div>
              <p>{x.detail}</p>
              <div className="row" style={{ gap: 6 }}>
                {x.nodes.length > 0 && <button className="btn sm" onClick={() => onShow(x.nodes)}>Show {x.nodes.length === 1 ? 'element' : `${x.nodes.length} elements`}</button>}
                {x.element && !x.nodes.length && <code className="t3 trunc f1">{x.element}</code>}
                <span className="f1" />
                <button className="btn sm ghost" onClick={() => onAdopt(x)}><Icon name="flag" size={11} />Add to findings</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

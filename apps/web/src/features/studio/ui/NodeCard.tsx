'use client';

import { UI_RULES, type UiIssue, type UiNode } from '@tb/contracts';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/providers';
import { firstFamily, nodeLabel } from './audit';
import s from './ui.module.css';

/** WCAG's contrast bars for this text: large text needs less. */
function contrastBars(n: UiNode) {
  const large = n.style.fontSize >= 24 || (n.style.fontSize >= 18.66 && (parseInt(n.style.fontWeight, 10) || 400) >= 700);
  return { aa: large ? 3 : 4.5, aaa: large ? 4.5 : 7, large };
}

function Swatch({ colour }: { colour: string }) {
  return <span className={s.swatch} style={{ background: colour }} aria-hidden />;
}

function Row({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : undefined}>{v}</dd>
    </>
  );
}

/** The CSS a developer would write to reproduce what the element renders with. */
export function cssOf(n: UiNode): string {
  const st = n.style;
  return [
    `/* ${n.selector} */`,
    `font-family: ${st.fontFamily};`,
    `font-size: ${st.fontSize}px;`,
    `font-weight: ${st.fontWeight};`,
    `line-height: ${st.lineHeight};`,
    st.letterSpacing !== 'normal' ? `letter-spacing: ${st.letterSpacing};` : '',
    `color: ${st.color};`,
    `background: ${st.background};`,
    `width: ${n.box.w}px;`,
    `height: ${n.box.h}px;`,
    `padding: ${st.padding};`,
    `margin: ${st.margin};`,
    st.borderRadius !== '0px' ? `border-radius: ${st.borderRadius};` : '',
    !st.border.startsWith('0px') ? `border: ${st.border};` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Everything the scan knows about one element. `compact` is the hover tooltip: identity, box, type
 * and colour at a glance; the full card adds spacing, layout, attributes and its issues.
 */
export function NodeCard({ node, issues, compact, onFlag }: { node: UiNode; issues: UiIssue[]; compact?: boolean; onFlag?(): void }) {
  const { notify } = useToast();
  const st = node.style;
  const bars = contrastBars(node);
  const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => notify(`${what} copied`), () => notify('Could not copy', 'bad'));
  const contrast =
    node.contrast === null ? (
      <span className="t3">{st.backgroundImage ? 'unknown (image behind)' : 'no text'}</span>
    ) : (
      <span className={s.contrast}>
        {node.contrast}:1
        <span className={node.contrast >= bars.aa ? s.ok : s.bad}>{node.contrast >= bars.aa ? <Icon name="check" size={10} /> : <Icon name="x" size={10} />}AA</span>
        <span className={node.contrast >= bars.aaa ? s.ok : s.bad}>{node.contrast >= bars.aaa ? <Icon name="check" size={10} /> : <Icon name="x" size={10} />}AAA</span>
      </span>
    );

  return (
    <div className={compact ? s.cardCompact : s.card}>
      <div className="row" style={{ gap: 6 }}>
        <span className="pill">{node.tag}</span>
        <span className={s.kind}>{node.kind}{node.role && node.role !== node.kind ? ` · ${node.role}` : ''}</span>
        <span className="f1" />
        <span className="mono t3">{node.box.w} × {node.box.h}</span>
      </div>
      {(node.name || node.text) && <div className={s.cardName}>{node.name || node.text}</div>}
      <dl className={s.props}>
        {!compact && <Row k="Accessible name" v={node.name || <span className={s.bad}>none</span>} mono={false} />}
        <Row k="Font" v={`${firstFamily(st.fontFamily)} ${st.fontSize}px / ${st.lineHeight} · ${st.fontWeight}`} />
        <Row k="Colour" v={<><Swatch colour={st.color} />{st.color}</>} />
        <Row k="Background" v={<><Swatch colour={st.background} />{st.background}{st.backgroundImage ? ' + image' : ''}</>} />
        <Row k="Contrast" v={contrast} mono={false} />
        {compact ? (
          <Row k="Padding" v={st.padding} />
        ) : (
          <>
            <Row k="Position" v={`x ${node.box.x}, y ${node.box.y}`} />
            <Row k="Padding" v={st.padding} />
            <Row k="Margin" v={st.margin} />
            <Row k="Border" v={st.border} />
            <Row k="Radius" v={st.borderRadius} />
            <Row k="Letter spacing" v={st.letterSpacing} />
            <Row k="Text" v={`${st.textAlign} · ${st.textTransform}`} />
            <Row k="Display" v={`${st.display} · ${st.position}${st.zIndex !== 'auto' ? ` · z ${st.zIndex}` : ''}${st.opacity < 1 ? ` · opacity ${st.opacity}` : ''}`} />
            <Row k="Keyboard" v={node.focusable ? 'focusable' : 'not focusable'} mono={false} />
            <Row k="Font stack" v={st.fontFamily} />
          </>
        )}
      </dl>
      {issues.length > 0 && (
        <ul className={s.cardIssues} aria-label="Issues on this element">
          {issues.map((i, n) => (
            <li key={n} className={s[UI_RULES[i.rule].severity]}>
              <Icon name="alert" size={11} />
              <span><b>{UI_RULES[i.rule].title}</b>{compact ? '' : ` · WCAG ${UI_RULES[i.rule].wcag}. ${i.message}`}</span>
            </li>
          ))}
        </ul>
      )}
      {!compact && (
        <>
          {node.attrs.length > 0 && (
            <dl className={s.props}>
              {node.attrs.map(([k, v]) => <Row key={k} k={k} v={v || '""'} />)}
            </dl>
          )}
          <code className={`${s.selector} trunc`} title={node.selector}>{node.selector}</code>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => copy(node.selector, 'Selector')}>Copy selector</button>
            <button className="btn sm" onClick={() => copy(cssOf(node), 'CSS')}>Copy CSS</button>
            <button className="btn sm" onClick={() => copy(`${nodeLabel(node)}\n${JSON.stringify({ box: node.box, style: node.style, contrast: node.contrast }, null, 2)}`, 'Details')}>Copy details</button>
            {onFlag && <button className="btn sm primary" onClick={onFlag}><Icon name="flag" size={11} />Flag finding</button>}
          </div>
        </>
      )}
      {compact && <div className={s.hint}>Click to select it in the tree</div>}
    </div>
  );
}

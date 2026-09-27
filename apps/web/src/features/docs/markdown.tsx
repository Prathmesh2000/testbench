import type { RequirementChange } from '@tb/contracts';
import type { ReactNode } from 'react';
import { anchorId, wordDiff, type Block, type DiffBlock } from './docs-utils';
import s from './docs.module.css';

// Minimal, safe markdown for PRDs: headings, paragraphs, lists, **bold**, `code` and requirement tags,
// built as React elements so document text can never inject markup.

export interface ReqContext {
  changeOf(ref: string): RequirementChange | undefined;
  selected?: string | null;
  onSelect(ref: string): void;
  /** Collects refs that already have an anchor; only the first tag of each ref gets the id. Absent in compare view. */
  anchored?: Set<string>;
}

const changeClass: Record<RequirementChange, string> = { unchanged: '', changed: s.chg!, added: s.add!, removed: s.rem! };
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\bREQ(?:-[A-Z0-9]+)+\b)/g;

function inline(text: string, ctx: ReqContext, keyBase: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}.${i}`;
    // split() with a capture group puts the matches at odd indexes.
    if (i % 2 === 0) return part;
    if (part.startsWith('**')) return <b key={key}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`')) return <code key={key} className="mono">{part.slice(1, -1)}</code>;
    const id = anchorId(part);
    const anchor = ctx.anchored && !ctx.anchored.has(id);
    ctx.anchored?.add(id);
    const change = ctx.changeOf(part);
    return (
      <a
        key={key}
        id={anchor ? id : undefined}
        href={`#${id}`}
        className={`${s.req} ${change ? changeClass[change] : ''} ${ctx.selected === part ? s.reqOn : ''}`}
        onClick={(e) => { e.preventDefault(); ctx.onSelect(part); }}
      >
        {part}
      </a>
    );
  });
}

/** One block; `render` turns its text (or each list item) into inline content. */
function BlockView({ block, render }: { block: Block; render(text: string, key: string): ReactNode }) {
  if (block.kind === 'heading') {
    const content = render(block.text, 'h');
    return block.level === 1 ? <h2>{content}</h2> : block.level === 2 ? <h3>{content}</h3> : <h4>{content}</h4>;
  }
  if (block.kind === 'para') return <p>{render(block.text, 'p')}</p>;
  const items = block.items.map((item, i) => <li key={i}>{render(item, `li${i}`)}</li>);
  return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
}

export function DocBody({ blocks, ctx }: { blocks: Block[]; ctx: ReqContext }) {
  return <>{blocks.map((b, i) => <BlockView key={i} block={b} render={(t, k) => inline(t, ctx, `${i}${k}`)} />)}</>;
}

/** The head version, with text removed since the base struck through and new text highlighted. */
export function DiffBody({ diff, ctx }: { diff: DiffBlock[]; ctx: ReqContext }) {
  return (
    <>
      {diff.map((d, i) => {
        if (d.kind === 'same') return <BlockView key={i} block={d.block} render={(t, k) => inline(t, ctx, `${i}${k}`)} />;
        if (d.kind === 'added') return <BlockView key={i} block={d.block} render={(t, k) => <ins key={k}>{inline(t, ctx, `${i}${k}`)}</ins>} />;
        if (d.kind === 'removed') return <BlockView key={i} block={d.block} render={(t, k) => <del key={k}>{inline(t, ctx, `${i}${k}`)}</del>} />;
        const { before, after } = d;
        // Lists diff item by item; an item with no counterpart diffs against the empty string.
        // ponytail: items dropped from the end of a list are not shown; diff lists with an item-level LCS if that matters.
        const beforeText = (k: string) =>
          before.kind !== 'list' ? before.text : after.kind === 'list' ? (before.items[Number(k.slice(2))] ?? '') : before.items.join(' ');
        return (
          <BlockView
            key={i}
            block={after}
            render={(text, k) => wordDiff(beforeText(k), text).map((seg, n) => {
              const content = inline(seg.text, ctx, `${i}${k}.${n}`);
              return seg.kind === 'del' ? <del key={n}>{content}</del> : seg.kind === 'ins' ? <ins key={n}>{content}</ins> : <span key={n}>{content}</span>;
            })}
          />
        );
      })}
    </>
  );
}

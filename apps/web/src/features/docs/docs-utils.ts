// Pure helpers for the Docs & PRDs screen: markdown block parsing, the version diff and case-key input.

export const REQ_ID = /\bREQ(?:-[A-Z0-9]+)+\b/;

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

/** Splits markdown or plain text into headings, paragraphs and lists. Anything richer reads as a paragraph. */
export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  // Cast, not annotation: TS would otherwise narrow this to null and miss the writes made inside flush().
  let list = null as Extract<Block, { kind: 'list' }> | null;
  const flush = () => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') });
    if (list) blocks.push(list);
    para = [];
    list = null;
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, text: heading[2]! });
    } else if (item) {
      const ordered = !item[1];
      if (para.length || list?.ordered !== ordered) flush();
      list ??= { kind: 'list', ordered, items: [] };
      list.items.push(item[2]!);
    } else if (list) {
      // A wrapped line continues the current list item.
      list.items[list.items.length - 1] += ` ${line}`;
    } else para.push(line);
  }
  flush();
  return blocks;
}

export type Segment = { kind: 'equal' | 'del' | 'ins'; text: string };

// Past this many LCS cells a paragraph is shown as fully replaced; keeps one giant paragraph from freezing the tab.
const MAX_CELLS = 400_000;

/** Word-level diff (LCS over words and the whitespace between them), with adjacent segments of a kind merged. */
export function wordDiff(a: string, b: string): Segment[] {
  const x = a.split(/(\s+)/).filter(Boolean);
  const y = b.split(/(\s+)/).filter(Boolean);
  // Trimming the shared prefix and suffix first makes the common "one phrase changed" case nearly free.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);

  const out: Segment[] = [];
  const push = (kind: Segment['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  x.slice(0, pre).forEach((t) => push('equal', t));
  if (xs.length * ys.length > MAX_CELLS) {
    xs.forEach((t) => push('del', t));
    ys.forEach((t) => push('ins', t));
  } else {
    // lcs[i][j] = LCS length of xs[i..] and ys[j..], filled backwards so the walk below goes forwards.
    const n = xs.length;
    const m = ys.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) lcs[i]![j] = xs[i] === ys[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) { push('equal', xs[i]!); i++; j++; }
      else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) push('del', xs[i++]!);
      else push('ins', ys[j++]!);
    }
  }
  x.slice(x.length - suf).forEach((t) => push('equal', t));
  return out;
}

export type DiffBlock =
  | { kind: 'same'; block: Block }
  | { kind: 'changed'; before: Block; after: Block }
  | { kind: 'added'; block: Block }
  | { kind: 'removed'; block: Block };

const REQ_KEY = /^REQ-/;
const blockText = (b: Block) => (b.kind === 'list' ? b.items.join('\n') : b.text);
/** Blocks that carry a requirement id pair up by that id even when their wording changed. */
const blockKey = (b: Block) => {
  const text = blockText(b);
  const ref = REQ_ID.exec(text);
  return ref && text.startsWith(ref[0]) ? ref[0] : `${b.kind}:${text}`;
};

/**
 * Aligns two versions block by block (LCS on block keys), so the word diff only ever runs inside one
 * paragraph. Unmatched blocks between two anchors pair up in order when they are the same kind.
 */
export function diffBlocks(base: Block[], head: Block[]): DiffBlock[] {
  const a = base.map(blockKey);
  const b = head.map(blockKey);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffBlock[] = [];
  let removed: Block[] = [];
  let added: Block[] = [];
  // A block keyed by a requirement id that found no partner really was added or removed; never pair it.
  const pairable = (x: Block, y: Block) => x.kind === y.kind && !REQ_KEY.test(blockKey(x)) && !REQ_KEY.test(blockKey(y));
  const flushGap = () => {
    while (removed.length && added.length && pairable(removed[0]!, added[0]!)) out.push({ kind: 'changed', before: removed.shift()!, after: added.shift()! });
    removed.forEach((block) => out.push({ kind: 'removed', block }));
    added.forEach((block) => out.push({ kind: 'added', block }));
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flushGap();
      const before = base[i++]!;
      const after = head[j++]!;
      out.push(blockText(before) === blockText(after) ? { kind: 'same', block: after } : { kind: 'changed', before, after });
    } else if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) removed.push(base[i++]!);
    else added.push(head[j++]!);
  }
  flushGap();
  return out;
}

/** Case keys from free text ("TC-1, tc-2 TC-3"), upper-cased and de-duplicated, plus whatever did not parse. */
export function parseCaseKeys(input: string): { keys: string[]; invalid: string[] } {
  const keys = new Set<string>();
  const invalid: string[] = [];
  for (const token of input.split(/[\s,;]+/).filter(Boolean)) {
    const key = token.toUpperCase();
    if (/^TC-\d+$/.test(key)) keys.add(key);
    else invalid.push(token);
  }
  return { keys: [...keys], invalid };
}

export const anchorId = (ref: string) => ref.toLowerCase();

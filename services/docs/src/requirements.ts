import type { ExtractedRequirement, RequirementDiff } from '@tb/contracts';

// Requirement extraction and version diffing (HLD §5.13). Pure functions, no I/O.

// "REQ-AP-04", "REQ-12": an uppercase REQ prefix and one or more segments.
const TAG = /\bREQ(?:-[A-Z0-9]+)+\b/;

/**
 * Requirements a PRD declares itself: each paragraph or list item that starts with a requirement id.
 * Documents written this way need no AI at all, and their ids stay stable across versions.
 */
export function taggedRequirements(body: string): ExtractedRequirement[] {
  const out: ExtractedRequirement[] = [];
  const seen = new Set<string>();
  for (const block of blocks(body)) {
    const line = block.replace(/\s+/g, ' ').trim();
    // Leading bullets, numbering and bold/code markers may wrap the id: "- **REQ-AP-04** A customer…".
    const m = /^(?:[-*]|\d+[.)])?\s*[*_`[]*\s*(REQ(?:-[A-Z0-9]+)+)\s*[*_`\]]*\s*[:.–—-]?\s*(.+)$/.exec(line);
    if (!m || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    const text = m[2]!.trim();
    out.push({ ref: m[1]!, title: shortTitle(text), text });
  }
  return out;
}

/** Paragraphs and list items; a heading, a blank line or a new list item ends the current one. */
function blocks(body: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(current.join(' '));
    current = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) flush();
    else {
      if (/^\s*(?:[-*]|\d+[.)])\s/.test(line)) flush();
      current.push(line);
    }
  }
  flush();
  return out;
}

export function hasTags(body: string): boolean {
  return TAG.test(body);
}

function shortTitle(text: string): string {
  const first = text.split(/(?<=[.!?])\s/)[0]!.replace(/[.]$/, '');
  return first.length <= 80 ? first : `${first.slice(0, 77).trimEnd()}…`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Word-set overlap (Jaccard), enough to tell "the same requirement, edited" from "a different one". */
export function similarity(a: string, b: string): number {
  const wa = new Set(norm(a).split(' '));
  const wb = new Set(norm(b).split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / (wa.size + wb.size - common || 1);
}

/**
 * Gives a newly extracted list the ids of the previous version where the requirement is the same or
 * an edit of it. An AI numbers requirements REQ-1, REQ-2… afresh each time, so inserting one near the
 * top would otherwise renumber, and "change", everything after it.
 */
export function alignRefs(
  prev: readonly ExtractedRequirement[],
  next: readonly ExtractedRequirement[],
): ExtractedRequirement[] {
  const unused = new Map(prev.map((p) => [p.ref, p]));
  const assigned = new Map<number, string>();
  // Exact text first, then the most similar remaining one above the threshold.
  next.forEach((n, i) => {
    const same = [...unused.values()].find((p) => norm(p.text) === norm(n.text));
    if (same) {
      assigned.set(i, same.ref);
      unused.delete(same.ref);
    }
  });
  next.forEach((n, i) => {
    if (assigned.has(i)) return;
    let best: ExtractedRequirement | null = null;
    let bestScore = 0.5;
    for (const p of unused.values()) {
      const score = similarity(p.text, n.text);
      if (score >= bestScore) [best, bestScore] = [p, score];
    }
    if (best) {
      assigned.set(i, best.ref);
      unused.delete(best.ref);
    }
  });
  let counter = Math.max(0, ...prev.map((p) => Number(/(\d+)$/.exec(p.ref)?.[1] ?? 0)));
  return next.map((n, i) => ({ ...n, ref: assigned.get(i) ?? `REQ-${++counter}` }));
}

/** Added, changed, removed and unchanged requirements between two versions, in the new version's order. */
export function diffRequirements(
  prev: readonly ExtractedRequirement[],
  next: readonly ExtractedRequirement[],
): RequirementDiff[] {
  const before = new Map(prev.map((p) => [p.ref, p.text]));
  const nextRefs = new Set(next.map((n) => n.ref));
  const out: RequirementDiff[] = next.map((n) => {
    const old = before.get(n.ref);
    if (old === undefined) return { ref: n.ref, change: 'added', before: null, after: n.text };
    return {
      ref: n.ref,
      change: norm(old) === norm(n.text) ? 'unchanged' : 'changed',
      before: old,
      after: n.text,
    };
  });
  for (const p of prev)
    if (!nextRefs.has(p.ref)) out.push({ ref: p.ref, change: 'removed', before: p.text, after: null });
  return out;
}

import type { Step } from '@tb/contracts';

export type StepChange =
  | { kind: 'same'; before: Step; after: Step }
  | { kind: 'changed'; before: Step; after: Step }
  | { kind: 'added'; after: Step }
  | { kind: 'removed'; before: Step };

const sameStep = (a: Step, b: Step) =>
  a.action === b.action && a.expected === b.expected && a.data === b.data;

/**
 * Step-level diff between two versions of a case, for the version history view.
 *
 * Aligns steps with a longest-common-subsequence match so inserting one step at the top does not make
 * every following step look changed. A removal directly followed by an addition at the same place is
 * reported as one `changed` step, which is how a reviewer thinks about an edited step.
 */
export function diffSteps(before: readonly Step[], after: readonly Step[]): StepChange[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] = length of the LCS of before[i..] and after[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = sameStep(before[i]!, after[j]!)
        ? lcs[i + 1]![j + 1]! + 1
        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const raw: StepChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && sameStep(before[i]!, after[j]!)) {
      raw.push({ kind: 'same', before: before[i++]!, after: after[j++]! });
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // On a tie, emit the removal first: the pairing pass below expects removed-then-added.
      raw.push({ kind: 'removed', before: before[i++]! });
    } else {
      raw.push({ kind: 'added', after: after[j++]! });
    }
  }

  // Pair each run of removals with the additions that immediately follow it.
  const out: StepChange[] = [];
  for (let k = 0; k < raw.length;) {
    if (raw[k]!.kind !== 'removed') {
      out.push(raw[k++]!);
      continue;
    }
    const removed: Step[] = [];
    while (k < raw.length && raw[k]!.kind === 'removed') removed.push((raw[k++] as { before: Step }).before);
    const added: Step[] = [];
    while (k < raw.length && raw[k]!.kind === 'added') added.push((raw[k++] as { after: Step }).after);
    const paired = Math.min(removed.length, added.length);
    for (let p = 0; p < paired; p++) out.push({ kind: 'changed', before: removed[p]!, after: added[p]! });
    for (const s of removed.slice(paired)) out.push({ kind: 'removed', before: s });
    for (const s of added.slice(paired)) out.push({ kind: 'added', after: s });
  }
  return out;
}

import type { CompareCategory, Criterion, CriterionStatus, Result } from '@tb/contracts';

// The judgement calls behind the reports, kept pure so they can be tested without a database.

export interface HistoryVerdict {
  alwaysFailing: boolean;
  flaky: boolean;
  flips: number;
}

/** A case is "always failing" after 5 straight failures, "flaky" after 3+ flips in its last 10 results (HLD §5.5, §5.16). */
export function classifyHistory(latestFirst: readonly ('passed' | 'failed')[]): HistoryVerdict {
  const last10 = latestFirst.slice(0, 10);
  let flips = 0;
  for (let i = 1; i < last10.length; i++) if (last10[i] !== last10[i - 1]) flips++;
  const alwaysFailing = last10.length >= 5 && last10.slice(0, 5).every((s) => s === 'failed');
  return { alwaysFailing, flaky: !alwaysFailing && flips >= 3, flips };
}

const executed = (r: Result | null): r is Result => r !== null && r !== 'untested';

/**
 * Where a case moved between two builds; null when nothing worth showing changed (passed both times,
 * or never run in either). Uses the result the run item recorded, so later edits to the case don't
 * change the comparison.
 */
export function classifyChange(base: Result | null, head: Result | null): CompareCategory | null {
  if (!executed(base)) return executed(head) ? 'added' : null;
  if (!executed(head)) return 'not_run';
  if (head === 'failed') return base === 'failed' ? 'still_failing' : 'new_failure';
  if (base === 'failed' && head === 'passed') return 'fixed';
  return null;
}

export const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

type Compare = '>=' | '<=';

/** One readiness criterion: a measured value against a target, or "no data" when nothing was measured. */
export function criterion(
  id: string,
  label: string,
  value: number | null,
  op: Compare,
  target: number,
  unit: '%' | '',
  evidence: string,
): Criterion {
  const fmt = (n: number) => `${n}${unit}`;
  const status: CriterionStatus =
    value === null ? 'no_data' : (op === '>=' ? value >= target : value <= target) ? 'met' : 'failing';
  const shownTarget =
    unit === '%' && target === 100 && op === '>='
      ? '100%'
      : op === '<=' && target === 0
        ? '0'
        : `${op === '>=' ? '≥' : '≤'} ${fmt(target)}`;
  return { id, label, target: shownTarget, actual: value === null ? '—' : fmt(value), status, evidence };
}

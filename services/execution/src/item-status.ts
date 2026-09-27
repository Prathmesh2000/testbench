import type { Result } from '@tb/contracts';

/**
 * The status of a whole run item, derived from its steps.
 *
 * - Any failed step fails the case, straight away: testers log the bug and move on without being made
 *   to mark the remaining steps.
 * - Otherwise any blocked step blocks it.
 * - Once every step has a result: all skipped → skipped, anything else → passed.
 * - A case part-way through stays untested; it only counts as executed when it is finished.
 */
export function deriveItemStatus(stepStatus: readonly Result[], stepCount: number): Result {
  if (stepStatus.includes('failed')) return 'failed';
  if (stepStatus.includes('blocked')) return 'blocked';
  const recorded = stepStatus.slice(0, stepCount).filter((s) => s !== 'untested');
  if (stepCount === 0 || recorded.length < stepCount) return 'untested';
  return recorded.every((s) => s === 'skipped') ? 'skipped' : 'passed';
}

/** Sets one step's status, padding earlier unrecorded steps with 'untested'. */
export function withStepStatus(
  stepStatus: readonly Result[],
  stepIndex: number,
  status: Result,
  stepCount: number,
): Result[] {
  const next: Result[] = Array.from({ length: stepCount }, (_, i) => stepStatus[i] ?? 'untested');
  next[stepIndex] = status;
  return next;
}

export type CounterField = 'passed' | 'failed' | 'blocked' | 'skipped';

/** How the run's counters move when an item goes from one status to another. */
export function counterDelta(from: Result, to: Result): Partial<Record<CounterField, number>> {
  const delta: Partial<Record<CounterField, number>> = {};
  if (from === to) return delta;
  if (from !== 'untested') delta[from] = -1;
  if (to !== 'untested') delta[to] = (delta[to] ?? 0) + 1;
  return delta;
}

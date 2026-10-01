import type { AutoStep, DraftRow, IntentCommitBody, IntentDraft, SaveComponentBody } from '@tb/contracts';
import { CHANGING_ACTIONS } from '@tb/contracts';
import type { z } from 'zod';

/** What the review settled on, ready to save: nothing here touches the database. */
export interface Assembled {
  /** New components to create, with the placeholder id each one replaces in the tests' steps. */
  components: Array<{ placeholderId: string; body: z.infer<typeof SaveComponentBody> }>;
  test: { title: string; steps: AutoStep[]; secrets: string[] };
  negative: { title: string; steps: AutoStep[]; secrets: string[] } | null;
  columns: string[];
  valid: Record<string, string>[];
  invalid: Record<string, string>[];
}

/**
 * Puts the accepted checks into the steps they belong to. A changing step whose checks were all
 * dropped is marked "no check needed" rather than refused at save: the tester chose that in review.
 */
export function withChecks(steps: AutoStep[], where: string, draft: IntentDraft, rejected: Set<string>): AutoStep[] {
  return steps.map((s) => {
    const mine = draft.checks.filter((c) => c.where === where && c.stepId === s.id && !rejected.has(c.id)).map((c) => c.assertion);
    const assertions = [...s.assertions, ...mine];
    return { ...s, assertions, noCheck: s.noCheck || (CHANGING_ACTIONS.includes(s.action) && assertions.length === 0) };
  });
}

export function assemble(draft: IntentDraft, review: Omit<IntentCommitBody, 'draft'>): Assembled {
  const rejected = new Set(review.rejectedChecks);
  const dropped = (list: 'valid' | 'invalid', i: number) => review.rejectedRows.some((r) => r.list === list && r.index === i);
  const components = draft.segments
    .filter((seg) => !seg.reuse)
    .map((seg) => {
      const renamed = review.renamed[seg.key];
      return {
        placeholderId: seg.placeholderId,
        body: {
          ...seg.component,
          ...(renamed ? { name: renamed.name, description: renamed.purpose } : {}),
          meta: { ...seg.component.meta, ...(renamed ? { purpose: renamed.purpose } : {}) },
          steps: withChecks(seg.component.steps, seg.key, draft, rejected),
        },
      };
    });
  const rows = (list: 'valid' | 'invalid', from: DraftRow[]) =>
    from.flatMap((r, i) => (dropped(list, i) ? [] : [{ ...r.values, case: r.case }]));
  const columns = [...new Set([...draft.valid, ...draft.invalid].flatMap((r) => Object.keys(r.values))), 'case'];
  return {
    components,
    test: { ...draft.test, steps: withChecks(draft.test.steps, 'test', draft, rejected) },
    negative: draft.negative && { ...draft.negative, steps: withChecks(draft.negative.steps, 'negative', draft, rejected) },
    columns,
    valid: rows('valid', draft.valid),
    invalid: rows('invalid', draft.invalid),
  };
}

/** Swaps each new component's placeholder id for the id it was saved under. */
export function linkComponents(steps: AutoStep[], saved: Map<string, string>): AutoStep[] {
  return steps.map((s) => (s.component && saved.has(s.component.id) ? { ...s, component: { ...s.component, id: saved.get(s.component.id)! } } : s));
}

import type { IntentDraft, PickedElement } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { applyAnswer } from './ai';
import type { AiContext } from './build';

const toast: PickedElement = { tag: 'div', role: 'status', text: '', xpath: '', suggestedName: '', page: '', url: '', locators: [{ strategy: 'testid', value: 'toast', code: '', matches: 1, stable: true }] };
const context: AiContext = {
  steps: [{ index: 0, where: 's1', stepId: 's1', action: 'click', element: 'Add to cart', value: '', page: '/p', observed: [{ ref: '0:0', kind: 'status', text: 'Added to cart' }] }],
  end: null,
  fields: [{ key: 'qty', label: 'Quantity', kind: 'number', rules: '', value: '1' }],
  segments: [{ key: 's1', name: 'Go through on P', purpose: '', steps: [0] }],
  refs: new Map([['0:0', toast]]),
};
const draft = {
  title: 'Add to cart', intent: { prerequisites: '', intent: 'Add an item', goal: 'Cart shows it' },
  segments: [{ key: 's1', role: 'segment', placeholderId: 'p', reuse: null, bindings: {}, component: { name: 'Go through on P', description: '', inputs: [], steps: [], changelog: '', meta: { purpose: '', leaves: 'On P', preconditions: '', tags: [], inputKinds: {}, origin: 'segment' } } }],
  test: { title: 'Add to cart', steps: [], secrets: [] }, negative: null, fields: [],
  valid: [{ values: { qty: '1' }, case: 'As recorded', source: 'recorded' }], invalid: [], checks: [], questions: [], submitStepId: null, baseUrl: '', pages: [], notes: [], ai: { status: 'off', message: null },
} as unknown as IntentDraft;

describe('applyAnswer', () => {
  const out = applyAnswer(draft, context, {
    checks: [
      { afterStep: 0, kind: 'text_contains', observed: '0:0', expected: 'Added to cart', why: 'The intent is adding.' },
      { afterStep: 0, kind: 'visible', observed: '9:9', why: 'Made up.' },
      { afterStep: null, kind: 'url_contains', observed: '', expected: '/cart', why: 'Goal.' },
    ],
    segments: [{ key: 's1', name: 'Add a product to the cart', purpose: 'Adds the open product to the cart.', leaves: 'One item in the cart' }],
    rows: [
      { values: { qty: '5' }, expect: 'valid', case: 'Five items' },
      { values: { colour: 'red' }, expect: 'valid', case: 'Unknown field' },
      { values: { qty: '-1' }, expect: 'invalid', case: 'Negative quantity' },
    ],
  });

  it('keeps checks on elements the recorder saw, marked as AI, and drops invented ones', () => {
    expect(out.checks.map((c) => [c.source, c.where, c.stepId, c.label])).toEqual([
      ['ai', 's1', 's1', '"toast" text contains "Added to cart"'],
      ['ai', 'test', 'goal', 'Address contains "/cart"'],
    ]);
    expect(out.notes.at(-1)).toBe('2 AI suggestions were left out: they pointed at something the recording did not see.');
  });

  it('names segments as business actions, and only adds rows for known fields', () => {
    expect(out.segments[0]!.component.name).toBe('Add a product to the cart');
    expect(out.segments[0]!.component.meta.leaves).toBe('One item in the cart');
    expect(out.valid.map((r) => r.case)).toEqual(['As recorded', 'Five items']);
    expect(out.invalid).toEqual([]); // no negative test to run invalid rows
  });
});

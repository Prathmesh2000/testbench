import type { PickedElement } from '@tb/contracts';
import { describe, expect, it } from 'vitest';
import { chooseLocator, policyFor } from './locators';

type C = PickedElement['locators'][number];
const c = (l: Partial<C> & Pick<C, 'strategy' | 'value'>): C => ({ code: '', matches: 1, stable: true, ...l });
const el = (tag: string, role: string | null, locators: C[]): PickedElement => ({ tag, role, text: '', xpath: '', suggestedName: '', page: '', url: '', locators });

const addButton = el('button', 'button', [
  c({ strategy: 'role', value: 'button', name: 'Add', matches: 4 }),
  c({ strategy: 'role', value: 'button', name: 'Add', within: { strategy: 'role', value: 'row', hasText: 'Dell XPS' } }),
  c({ strategy: 'role', value: 'button', name: 'Add', nth: 1, stable: false }),
  c({ strategy: 'css', value: 'tr:nth-of-type(2) > td > button' }),
]);

describe('policyFor', () => {
  it('reads positions and references from the intent', () => {
    expect(policyFor('Check the checkout total')).toEqual({ positional: false, referential: false, positionalControls: false });
    expect(policyFor('Open the first result').positional).toBe(true);
    expect(policyFor('Open the first result').positionalControls).toBe(false);
    expect(policyFor('Click the second Add button').positionalControls).toBe(true);
    expect(policyFor('Check the price next to Dell XPS').referential).toBe(true);
  });
});

describe('chooseLocator', () => {
  it('never finds a button by position unless the intent asks for that button by position', () => {
    expect(chooseLocator(addButton, policyFor('Add Dell XPS to the cart'))).toEqual({
      strategy: 'role', value: 'button', name: 'Add', within: { strategy: 'role', value: 'row', hasText: 'Dell XPS' },
    });
    expect(chooseLocator(addButton, policyFor('Open the first result'))!.nth).toBeUndefined();
    expect(chooseLocator(addButton, policyFor('Click the second Add button'))!.nth).toBe(1);
    const onlyByPosition = el('button', 'button', [c({ strategy: 'role', value: 'button', name: 'Add', nth: 1, stable: false }), c({ strategy: 'css', value: 'x > button' })]);
    expect(chooseLocator(onlyByPosition, policyFor('Add to cart'))).toEqual({ strategy: 'css', value: 'x > button' });
    expect(chooseLocator(onlyByPosition, policyFor('Click the second Add button'))!.nth).toBe(1);
  });

  it('lets content be found by position when the intent is about position', () => {
    const result = el('li', 'listitem', [c({ strategy: 'role', value: 'listitem', nth: 0, stable: false }), c({ strategy: 'css', value: 'ul > li:nth-of-type(1)' })]);
    expect(chooseLocator(result, policyFor('Open the first result'))!.nth).toBe(0);
    expect(chooseLocator(result, policyFor('Open a result'))!.strategy).toBe('css');
  });

  it('prefers a stable name over data on the page', () => {
    const price = el('span', null, [c({ strategy: 'text', value: '₹49,999', stable: false }), c({ strategy: 'testid', value: 'price' })]);
    expect(chooseLocator(price, policyFor('Check the price'))).toEqual({ strategy: 'testid', value: 'price' });
  });
});

import { describe, expect, it } from 'vitest';
import { stepsToGherkin, tokenizeGherkinLine } from './gherkin';

const steps = [
  { action: 'Open the payment page', expected: 'Page loads', data: '' },
  { action: 'Pay ₹499 with UPI collect', expected: 'Status is PENDING', data: '' },
  { action: 'Wait 5 minutes', expected: '', data: '' },
];

describe('stepsToGherkin', () => {
  it('uses the precondition as Given and actions as When/And', () => {
    expect(stepsToGherkin('Collect expiry', 'Merchant is onboarded', steps)).toBe(
      [
        'Scenario: Collect expiry',
        '  Given merchant is onboarded',
        '  When open the payment page',
        '  And pay ₹499 with UPI collect',
        '  And wait 5 minutes',
        '  Then page loads',
        '  And status is PENDING',
      ].join('\n'),
    );
  });

  it('uses the first step as Given when there is no precondition', () => {
    const text = stepsToGherkin('X', '', steps);
    expect(text).toContain('  Given open the payment page\n  When pay ₹499');
  });
});

describe('tokenizeGherkinLine', () => {
  it('separates the keyword and quoted strings', () => {
    expect(tokenizeGherkinLine('  When I enter "qa@okaxis"')).toEqual([
      { text: '  ', kind: 'text' },
      { text: 'When', kind: 'kw' },
      { text: ' I enter ', kind: 'text' },
      { text: '"qa@okaxis"', kind: 'str' },
    ]);
  });

  it('does not treat a word that merely starts with a keyword as one', () => {
    expect(tokenizeGherkinLine('Andrew pays')[0]).toEqual({ text: 'Andrew pays', kind: 'text' });
  });
});

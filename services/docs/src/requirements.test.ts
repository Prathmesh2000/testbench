import { describe, expect, it } from 'vitest';
import { alignRefs, diffRequirements, similarity, taggedRequirements } from './requirements';

const V2 = `# UPI Autopay mandates

Autopay lets a customer authorise recurring debits.

## Pausing
REQ-AP-04 A customer can pause an active mandate for up to 30 days.

- **REQ-AP-05** Resuming recalculates the next debit date from the original schedule.
- REQ-AP-10: Revoking a mandate requires OTP confirmation.`;

const V3 = `# UPI Autopay mandates

## Pausing
REQ-AP-04 A customer can pause an active mandate for up to 90 days.

- **REQ-AP-05** Resuming recalculates the next debit date from the original schedule.
- REQ-AP-11 Pause and resume confirmations are sent in the customer's selected language.`;

describe('taggedRequirements', () => {
  it('reads ids from paragraphs and list items, with or without bold and colons', () => {
    const reqs = taggedRequirements(V2);
    expect(reqs.map((r) => r.ref)).toEqual(['REQ-AP-04', 'REQ-AP-05', 'REQ-AP-10']);
    expect(reqs[2]).toMatchObject({
      text: 'Revoking a mandate requires OTP confirmation.',
      title: 'Revoking a mandate requires OTP confirmation',
    });
  });

  it('ignores a document without ids', () => {
    expect(taggedRequirements('Customers can pause mandates.\n\nThey can resume them.')).toEqual([]);
  });
});

describe('diffRequirements', () => {
  it('classifies each requirement against the previous version', () => {
    const d = diffRequirements(taggedRequirements(V2), taggedRequirements(V3));
    expect(d.map((x) => [x.ref, x.change])).toEqual([
      ['REQ-AP-04', 'changed'],
      ['REQ-AP-05', 'unchanged'],
      ['REQ-AP-11', 'added'],
      ['REQ-AP-10', 'removed'],
    ]);
  });

  it('treats whitespace and punctuation edits as unchanged', () => {
    const a = [{ ref: 'R', title: 't', text: 'Debits are skipped, not queued.' }];
    const b = [{ ref: 'R', title: 't', text: 'Debits are  skipped not queued' }];
    expect(diffRequirements(a, b)[0]!.change).toBe('unchanged');
  });
});

describe('alignRefs', () => {
  const prev = [
    { ref: 'REQ-1', title: '', text: 'A customer can pause a mandate for up to 30 days.' },
    { ref: 'REQ-2', title: '', text: 'A pre-debit notification is sent 48 hours before each execution.' },
  ];

  it('keeps ids stable when a requirement is inserted above others', () => {
    const next = [
      { ref: 'REQ-1', title: '', text: 'Mandates can be created from the PSP app only.' },
      { ref: 'REQ-2', title: '', text: 'A customer can pause a mandate for up to 90 days.' },
      { ref: 'REQ-3', title: '', text: 'A pre-debit notification is sent 48 hours before each execution.' },
    ];
    expect(alignRefs(prev, next).map((r) => r.ref)).toEqual(['REQ-3', 'REQ-1', 'REQ-2']);
  });

  it('scores edits as similar and unrelated text as not', () => {
    expect(similarity(prev[0]!.text, 'A customer can pause a mandate for up to 90 days.')).toBeGreaterThan(
      0.5,
    );
    expect(similarity(prev[0]!.text, 'Merchants receive webhooks within 5 seconds.')).toBeLessThan(0.2);
  });
});

import { describe, expect, it } from 'vitest';
import { diffBlocks, parseBlocks, parseCaseKeys, wordDiff } from './docs-utils';

describe('docs utils', () => {
  it('parses headings, paragraphs and lists', () => {
    const blocks = parseBlocks('# Title\n\nFirst line\nwraps here.\n## 1. Section\n- one\n- two\n  continued\n\n1. a\n2. b\n#### deep');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'para', text: 'First line wraps here.' },
      { kind: 'heading', level: 2, text: '1. Section' },
      { kind: 'list', ordered: false, items: ['one', 'two continued'] },
      { kind: 'list', ordered: true, items: ['a', 'b'] },
      { kind: 'heading', level: 3, text: 'deep' },
    ]);
  });

  it('diffs words and keeps the untouched text intact', () => {
    const segs = wordDiff('pause for up to 30 days. Debits are skipped.', 'pause for up to 90 days. Debits are skipped, not queued.');
    expect(segs.filter((s) => s.kind !== 'equal')).toEqual([
      { kind: 'del', text: '30' },
      { kind: 'ins', text: '90' },
      { kind: 'del', text: 'skipped.' },
      { kind: 'ins', text: 'skipped, not queued.' },
    ]);
    expect(segs.filter((s) => s.kind !== 'ins').map((s) => s.text).join('')).toBe('pause for up to 30 days. Debits are skipped.');
    expect(segs.filter((s) => s.kind !== 'del').map((s) => s.text).join('')).toBe('pause for up to 90 days. Debits are skipped, not queued.');
    expect(wordDiff('same text', 'same text')).toEqual([{ kind: 'equal', text: 'same text' }]);
  });

  it('aligns blocks by requirement id and marks what was added or removed', () => {
    const base = parseBlocks('## Pausing\nREQ-AP-04 Pause for 30 days.\n\nREQ-AP-10 Revoke needs OTP.');
    const head = parseBlocks('## Pausing\nREQ-AP-04 Pause for 90 days.\n\nREQ-AP-11 Confirmations in the selected language.');
    expect(diffBlocks(base, head).map((d) => d.kind)).toEqual(['same', 'changed', 'removed', 'added']);
  });

  it('pairs unmatched paragraphs so a reworded one diffs in place', () => {
    const d = diffBlocks(parseBlocks('Intro.\n\nOld wording here.'), parseBlocks('Intro.\n\nNew wording here.'));
    expect(d.map((x) => x.kind)).toEqual(['same', 'changed']);
  });

  it('reads case keys from free text', () => {
    expect(parseCaseKeys('TC-1, tc-2  TC-1;TC-30 nope')).toEqual({ keys: ['TC-1', 'TC-2', 'TC-30'], invalid: ['nope'] });
  });
});

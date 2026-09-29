import { describe, expect, it } from 'vitest';
import { diagnose, STARTER } from './code';

describe('code workspace', () => {
  it('ships a starter framework that compiles', () => {
    for (const [path, content] of Object.entries(STARTER))
      expect(diagnose(path, content), path).toEqual([]);
  });

  it('reports the line of a syntax problem', () => {
    const issues = diagnose('tests/a.spec.ts', 'export const x = (1;\n');
    expect(issues[0]).toMatchObject({ line: 1 });
  });

  it('accepts valid JSON and rejects broken JSON', () => {
    expect(diagnose('data/x.json', '{"a":1}')).toEqual([]);
    expect(diagnose('data/x.json', '{oops}')).toHaveLength(1);
  });

  it('gives the helpers testers reach for most', () => {
    expect(Object.keys(STARTER)).toEqual(
      expect.arrayContaining(['utils/wait.ts', 'utils/testdata.ts', 'utils/env.ts', 'fixtures/index.ts']),
    );
    // No fixed sleeps anywhere in what we hand people: that is how flaky suites start.
    for (const [path, content] of Object.entries(STARTER))
      expect(content, path).not.toMatch(/waitForTimeout|setTimeout\(/);
  });
});

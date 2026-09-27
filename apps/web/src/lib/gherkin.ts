import type { Step } from '@tb/contracts';

/**
 * Renders a step-table case as Gherkin, for the Steps / Gherkin toggle on case detail.
 * The first step is the precondition (Given); later actions are When/And; expected results become Then/And.
 */
export function stepsToGherkin(title: string, preconditions: string, steps: readonly Step[]): string {
  const lines = [`Scenario: ${title}`];
  if (preconditions.trim()) lines.push(`  Given ${lowerFirst(preconditions.trim())}`);
  steps.forEach((s, i) => {
    const keyword = i === 0 && !preconditions.trim() ? 'Given' : i === 0 || (i === 1 && !preconditions.trim()) ? 'When' : 'And';
    lines.push(`  ${keyword} ${lowerFirst(s.action)}`);
  });
  const expectations = steps.map((s) => s.expected).filter(Boolean);
  expectations.forEach((e, i) => lines.push(`  ${i === 0 ? 'Then' : 'And'} ${lowerFirst(e)}`));
  return lines.join('\n');
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

export type GherkinToken = { text: string; kind: 'kw' | 'str' | 'text' };

/** Splits one line of Gherkin into keyword, quoted strings and plain text for highlighting. */
export function tokenizeGherkinLine(line: string): GherkinToken[] {
  const out: GherkinToken[] = [];
  const kw = /^(\s*)(Feature:|Scenario Outline:|Scenario:|Background:|Examples:|Given|When|Then|And|But)(?=\s|$)/.exec(line);
  let rest = line;
  if (kw) {
    if (kw[1]) out.push({ text: kw[1], kind: 'text' });
    out.push({ text: kw[2]!, kind: 'kw' });
    rest = line.slice(kw[0].length);
  }
  for (const part of rest.split(/("[^"]*"|“[^”]*”)/)) {
    if (part) out.push({ text: part, kind: /^["“]/.test(part) ? 'str' : 'text' });
  }
  return out;
}

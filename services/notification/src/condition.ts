// Rule conditions: `severity = Blocker`, `count > 10`, `severity IN (Blocker, Critical) AND count >= 1`.
// A small AND-only language over the event's data, evaluated before a rule sends anything.

export class ConditionError extends Error {}

type Clause = { field: string; op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'IN'; values: string[] };

/** Parses a condition; throws ConditionError with a readable message so the rule editor can show it. */
export function parseCondition(text: string): Clause[] {
  if (!text.trim()) return [];
  return text.split(/\s+AND\s+/i).map((part) => {
    const m = /^\s*([a-zA-Z]\w*)\s*(>=|<=|!=|=|>|<|\bIN\b)\s*(.+?)\s*$/i.exec(part);
    if (!m)
      throw new ConditionError(
        `Could not read “${part.trim()}”. Use field = value, e.g. severity = Blocker.`,
      );
    const op = m[2]!.toUpperCase() as Clause['op'];
    const raw = m[3]!;
    const values =
      op === 'IN'
        ? (/^\((.*)\)$/.exec(raw)?.[1] ?? raw)
            .split(',')
            .map((v) => v.trim().replace(/^"(.*)"$/, '$1'))
            .filter(Boolean)
        : [raw.replace(/^"(.*)"$/, '$1')];
    if (!values.length) throw new ConditionError(`“${part.trim()}” needs at least one value.`);
    return { field: m[1]!, op, values };
  });
}

/** True when every clause holds. Numbers compare as numbers; everything else case-insensitively. */
export function matches(text: string, data: Record<string, unknown>): boolean {
  return parseCondition(text).every(({ field, op, values }) => {
    const actual = data[field];
    if (actual === undefined || actual === null) return op === '!=';
    const a = String(actual).toLowerCase();
    const wanted = values.map((v) => v.toLowerCase());
    switch (op) {
      case '=':
        return a === wanted[0];
      case '!=':
        return a !== wanted[0];
      case 'IN':
        return wanted.includes(a);
      default: {
        const x = Number(actual);
        const y = Number(values[0]);
        if (Number.isNaN(x) || Number.isNaN(y)) return false;
        return op === '>' ? x > y : op === '>=' ? x >= y : op === '<' ? x < y : x <= y;
      }
    }
  });
}

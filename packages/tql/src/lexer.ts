// Tokenizer for TQL, the JQL-style query language for test cases (HLD §6). Shared by the API, which
// executes queries, and the web app, which highlights and autocompletes them.

export type TokenKind =
  'word' | 'string' | 'number' | 'relative' | 'op' | 'lparen' | 'rparen' | 'comma' | 'keyword';

export interface Token {
  kind: TokenKind;
  /** Source text for words/ops; the unquoted content for strings; upper-cased for keywords. */
  value: string;
  start: number;
  end: number;
  /** `"otp retry"~3`: the words may be up to 3 positions apart. */
  proximity?: number;
}

export class TqlError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
  ) {
    super(message);
    this.name = 'TqlError';
  }
}

export const KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IN',
  'IS',
  'EMPTY',
  'ORDER',
  'GROUP',
  'BY',
  'ASC',
  'DESC',
]);
const OPERATORS = ['>=', '<=', '!=', '!~', '=', '~', '>', '<'];

/**
 * Splits a query into tokens. Words cover field names, enum values, labels (release-4.18) and case keys
 * (TC-10231); quoted strings carry anything else. Unterminated quotes are an error with a position, so
 * the editor can underline the exact spot.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === '"' || ch === '“') {
      const close = ch === '“' ? '”' : '"';
      let j = i + 1;
      let text = '';
      while (j < input.length && input[j] !== close) {
        // \" inside a string is a literal quote.
        if (input[j] === '\\' && j + 1 < input.length) j++;
        text += input[j];
        j++;
      }
      if (j >= input.length) throw new TqlError('This quote is never closed', start, input.length);
      j++;
      const token: Token = { kind: 'string', value: text, start, end: j };
      const prox = /^~(\d{1,2})/.exec(input.slice(j));
      if (prox) {
        token.proximity = Number(prox[1]);
        j += prox[0].length;
        token.end = j;
      }
      tokens.push(token);
      i = j;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', value: ch, start, end: ++i });
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', value: ch, start, end: ++i });
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', value: ch, start, end: ++i });
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    // "-7d" is a relative date, not "minus": it only appears as a value, never after a word character.
    const relative = /^-(\d{1,4})([hdw])\b/.exec(input.slice(i));
    if (relative) {
      tokens.push({ kind: 'relative', value: relative[0], start, end: i + relative[0].length });
      i += relative[0].length;
      continue;
    }
    if (op) {
      tokens.push({ kind: 'op', value: op, start, end: i + op.length });
      i += op.length;
      continue;
    }
    const word = /^[\p{L}\p{N}_.:@/+-]+/u.exec(input.slice(i));
    if (!word) throw new TqlError(`Unexpected character “${ch}”`, start, start + 1);
    const text = word[0];
    const upper = text.toUpperCase();
    if (KEYWORDS.has(upper)) tokens.push({ kind: 'keyword', value: upper, start, end: i + text.length });
    else if (/^\d+(\.\d+)?$/.test(text))
      tokens.push({ kind: 'number', value: text, start, end: i + text.length });
    else tokens.push({ kind: 'word', value: text, start, end: i + text.length });
    i += text.length;
  }
  return tokens;
}

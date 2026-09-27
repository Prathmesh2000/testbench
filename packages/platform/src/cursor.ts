import { badRequest } from './errors';

// Keyset pagination cursors: the sort values of the last row on a page, opaque to the client.
// Keyset rather than OFFSET because OFFSET makes the database walk and discard every earlier row;
// page 5,000 of a 10M-case project would read half a million rows to return a hundred.

export type CursorValue = string | number | null;

export function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/** Decodes a cursor made by encodeCursor, expecting exactly `arity` values. */
export function decodeCursor(cursor: string, arity: number): CursorValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('The page cursor is not valid. Reload the list.');
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length === arity &&
    parsed.every((v) => v === null || typeof v === 'string' || typeof v === 'number');
  if (!valid) throw badRequest('The page cursor is not valid. Reload the list.');
  return parsed as CursorValue[];
}

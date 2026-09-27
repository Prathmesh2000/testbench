import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';
import { AppError } from './errors';

describe('keyset cursor', () => {
  it('round-trips mixed values, including null sort keys', () => {
    const values = ['P1', 10231, null];
    expect(decodeCursor(encodeCursor(values), 3)).toEqual(values);
  });

  it('is URL-safe', () => {
    expect(encodeCursor(['Verify collect request ₹1,00,000 / Safari?', 1])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['garbage', 'not-base64-json'],
    ['wrong arity', encodeCursor(['a'])],
    ['non-array', Buffer.from('{"a":1}').toString('base64url')],
    ['nested objects', Buffer.from('[{"a":1},2]').toString('base64url')],
  ])('rejects %s with a 400', (_name, cursor) => {
    expect(() => decodeCursor(cursor, 2)).toThrow(AppError);
    try {
      decodeCursor(cursor, 2);
    } catch (err) {
      expect((err as AppError).status).toBe(400);
    }
  });
});

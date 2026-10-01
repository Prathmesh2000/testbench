import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractJson, schemaInstruction } from './json-answer';

describe('extractJson', () => {
  it('reads JSON however the model wrapped it', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a": {"b": [1, 2]}} Hope that helps.')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson('{"text": "a } inside a string", "n": 2}')).toEqual({ text: 'a } inside a string', n: 2 });
    expect(extractJson('[{"x": 1}]')).toEqual([{ x: 1 }]);
  });

  it('finds nothing where there is nothing', () => {
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{ broken')).toBeUndefined();
  });

  it('describes the shape the task needs', () => {
    expect(schemaInstruction(z.object({ reply: z.string() }))).toContain('"reply"');
  });
});

import { z } from 'zod';

/**
 * The JSON inside a model's answer. Models reached through Ollama's cloud ignore the response format
 * and answer the way they like to: fenced in ```json, or with a sentence before it. The value found
 * here is still checked against the task's schema before anything uses it.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const open = candidate[start]!;
    const close = open === '{' ? '}' : ']';
    // The balanced object or array from its first bracket, strings respected.
    let depth = 0;
    let inString = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

/** The instruction that makes a model which ignores the response format answer in the task's shape. */
export function schemaInstruction(schema: z.ZodType): string {
  return `Answer with one JSON object only, no prose and no code fence, that matches this JSON Schema exactly:\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

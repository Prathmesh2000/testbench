import { createHash } from 'node:crypto';
import type { DependencyLink, EnrichmentAnswer, EnrichmentKind, OverlayPatch } from '@tb/contracts';
import { deref, readSpec } from './spec';

// The enrichment layer (plan §9): find what a thin spec leaves out, ask the tester, and keep the answers
// as JSON-pointer patches next to the spec. The uploaded document is never edited; the effective spec
// is the document with the patches applied, and every patch says which question it answers.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const esc = (p: string) => p.replace(/~/g, '~0').replace(/\//g, '~1');
const unesc = (p: string) => p.replace(/~1/g, '/').replace(/~0/g, '~');

export interface Gap {
  id: string;
  kind: EnrichmentKind;
  operation: string;
  /** Where the answer goes in the document (the operation, a schema, a field). */
  pointer: string;
  field: string | null;
  prompt: string;
  /** How much answering helps testing; questions are asked highest first. */
  impact: number;
  /** For a dependency question: the guessed link to confirm. */
  link?: Pick<DependencyLink, 'from' | 'to' | 'param' | 'field'>;
}

const IMPACT: Record<EnrichmentKind, number> = { security: 5, error_response: 4, required: 4, constraints: 3, dependency: 3, example: 2, side_effect: 2, business_rule: 1 };
const gapId = (kind: string, pointer: string, field: string | null) => createHash('sha1').update(`${kind}|${pointer}|${field ?? ''}`).digest('hex').slice(0, 20);

/** Reads the value at a JSON pointer, or undefined. */
export function getAt(doc: unknown, pointer: string): unknown {
  let at: unknown = doc;
  for (const part of pointer.replace(/^#?\/?/, '').split('/').filter((p) => p !== '')) at = isObj(at) || Array.isArray(at) ? (at as Obj)[unesc(part)] : undefined;
  return at;
}

/** Follows $refs from a pointer to where the schema really lives, so a patch lands on the shared component. */
export function resolvePointer(doc: unknown, pointer: string): string {
  let p = pointer;
  for (let i = 0; i < 10; i++) {
    const v = getAt(doc, p);
    if (!isObj(v) || typeof v.$ref !== 'string' || !v.$ref.startsWith('#/')) return p;
    p = v.$ref;
  }
  return p;
}

/** The document with patches applied. Patches whose parent no longer exists are skipped and returned. */
export function applyPatches(doc: unknown, patches: OverlayPatch[]): { doc: unknown; skipped: OverlayPatch[] } {
  const out = structuredClone(doc) as Obj;
  const skipped: OverlayPatch[] = [];
  for (const p of patches) {
    const parts = p.pointer.replace(/^#?\//, '').split('/').map(unesc);
    const key = parts.pop()!;
    const parent = getAt(out, `#/${parts.map(esc).join('/')}`);
    if (!isObj(parent) && !Array.isArray(parent)) {
      skipped.push(p);
      continue;
    }
    const target = parent as Obj;
    if (p.op === 'merge' && isObj(target[key]) && isObj(p.value)) target[key] = { ...(target[key] as Obj), ...p.value };
    else if (p.op === 'append' && Array.isArray(target[key])) target[key] = [...(target[key] as unknown[]), p.value];
    else if (p.op === 'append') target[key] = [p.value];
    else target[key] = p.value;
  }
  return { doc: out, skipped };
}

const jsonContent = (c: unknown): string | null => (isObj(c) ? (Object.keys(c).find((t) => t.includes('json')) ?? null) : null);

/** What the spec does not say that testing needs, one question per gap. */
export function detectGaps(raw: unknown, weakLinks: DependencyLink[] = []): Gap[] {
  const doc = raw as Obj;
  const read = readSpec(doc);
  const swagger2 = String(doc.swagger ?? '').startsWith('2.');
  const gaps: Gap[] = [];
  const add = (g: Omit<Gap, 'id' | 'impact'>) => gaps.push({ ...g, id: gapId(g.kind, g.pointer, g.field), impact: IMPACT[g.kind] });
  const paths = doc.paths as Obj;
  const globalSecurity = Array.isArray(doc.security);

  for (const o of read.operations) {
    const key = `${o.method} ${o.path}`;
    const opPtr = `#/paths/${esc(o.path)}/${o.method.toLowerCase()}`;
    const op = deref(doc, (deref(doc, paths[o.path]) as Obj)[o.method.toLowerCase()]) as Obj;
    const responses = isObj(op.responses) ? op.responses : {};
    const codes = Object.keys(responses);

    if (!Array.isArray(op.security) && !globalSecurity)
      add({ kind: 'security', operation: key, pointer: opPtr, field: null, prompt: `Does ${key} need a credential? If so, which scheme, and which roles may call it?` });
    if (!codes.some((c) => /^4/.test(c)))
      add({ kind: 'error_response', operation: key, pointer: `${opPtr}/responses`, field: null, prompt: `What does ${key} return when the input is wrong? Give the status and an example body.` });
    if (o.method === 'DELETE') add({ kind: 'side_effect', operation: key, pointer: opPtr, field: null, prompt: `Does ${key} remove the record, or mark it (a soft delete, like status = cancelled)?` });
    if (o.method === 'POST' || o.method === 'PUT' || o.method === 'PATCH')
      add({ kind: 'business_rule', operation: key, pointer: opPtr, field: null, prompt: `Is there a rule the response of ${key} must follow, like "total equals the sum of price × qty"?` });

    // The request body schema, followed to where it lives.
    let bodyPtr: string | null = null;
    if (swagger2) {
      const i = Array.isArray(op.parameters) ? op.parameters.findIndex((p) => (deref(doc, p) as Obj)?.in === 'body') : -1;
      if (i >= 0) bodyPtr = resolvePointer(doc, `${opPtr}/parameters/${i}/schema`);
    } else if (op.requestBody) {
      const rbPtr = resolvePointer(doc, `${opPtr}/requestBody`);
      const ct = jsonContent((getAt(doc, rbPtr) as Obj | undefined)?.content);
      if (ct) {
        bodyPtr = resolvePointer(doc, `${rbPtr}/content/${esc(ct)}/schema`);
        const media = getAt(doc, `${rbPtr}/content/${esc(ct)}`) as Obj;
        const schema = getAt(doc, bodyPtr) as Obj | undefined;
        if (media.example === undefined && media.examples === undefined && schema?.example === undefined)
          add({ kind: 'example', operation: key, pointer: `${rbPtr}/content/${esc(ct)}`, field: null, prompt: `What does a realistic request body for ${key} look like?` });
      }
    }
    const schema = bodyPtr ? (getAt(doc, bodyPtr) as Obj | undefined) : undefined;
    if (isObj(schema) && isObj(schema.properties)) {
      if (!Array.isArray(schema.required))
        add({ kind: 'required', operation: key, pointer: bodyPtr!, field: null, prompt: `Which fields of the ${key} body are required?` });
      for (const [name, raw] of Object.entries(schema.properties)) {
        const fPtr = resolvePointer(doc, `${bodyPtr}/properties/${esc(name)}`);
        const f = getAt(doc, fPtr);
        if (!isObj(f)) continue;
        const numeric = f.type === 'integer' || f.type === 'number';
        const text = f.type === 'string' && !f.format;
        const bounded = numeric ? f.minimum !== undefined || f.maximum !== undefined || f.enum !== undefined : f.maxLength !== undefined || f.pattern !== undefined || f.enum !== undefined;
        if ((numeric || text) && !bounded)
          add({ kind: 'constraints', operation: key, pointer: fPtr, field: name, prompt: numeric ? `What range is allowed for ${name} in ${key}? (minimum, maximum, or the allowed values)` : `What is allowed for ${name} in ${key}? (maximum length, a pattern, or the allowed values)` });
        void raw;
      }
    }
  }
  for (const l of weakLinks)
    if (l.source === 'inferred' && l.confidence < 0.8 && l.field)
      add({ kind: 'dependency', operation: l.to, pointer: `#/x-links/${esc(l.from)}/${esc(l.param.name)}`, field: l.param.name, prompt: `Does ${l.param.name} in ${l.to} come from ${l.from}, at ${l.field}?`, link: { from: l.from, to: l.to, param: l.param, field: l.field } });
  return gaps.sort((a, b) => b.impact - a.impact || a.operation.localeCompare(b.operation));
}

export class AnswerError extends Error {}

/** The patches an answer becomes. A dependency answer has none: it is a link decision instead. */
export function answerToPatches(gap: Gap, answer: EnrichmentAnswer, doc: unknown): OverlayPatch[] {
  const q = gap.id;
  switch (answer.kind) {
    case 'security':
      return [{ pointer: `${gap.pointer}/security`, op: 'set', value: answer.scheme ? [{ [answer.scheme]: [] }] : [], question: q }, ...(answer.roles.length ? [{ pointer: `${gap.pointer}/x-tb-roles`, op: 'set' as const, value: answer.roles, question: q }] : [])];
    case 'error_response': {
      let body: unknown = undefined;
      if (answer.body.trim()) {
        try {
          body = JSON.parse(answer.body);
        } catch {
          throw new AnswerError('The example body is not valid JSON.');
        }
      }
      return [{ pointer: `${gap.pointer}/${answer.status}`, op: 'set', value: { description: answer.description || `Error ${answer.status}`, ...(body !== undefined ? { content: { 'application/json': { example: body } } } : {}) }, question: q }];
    }
    case 'required': {
      const props = Object.keys(((getAt(doc, gap.pointer) as Obj | undefined)?.properties as Obj | undefined) ?? {});
      const unknown = answer.fields.filter((f) => !props.includes(f));
      if (unknown.length) throw new AnswerError(`The body has no field ${unknown.join(', ')}.`);
      return [{ pointer: `${gap.pointer}/required`, op: 'set', value: answer.fields, question: q }];
    }
    case 'constraints': {
      const value: Obj = {};
      if (answer.minimum !== null) value.minimum = answer.minimum;
      if (answer.maximum !== null) value.maximum = answer.maximum;
      if (answer.maxLength !== null) value.maxLength = answer.maxLength;
      if (answer.pattern) {
        try {
          new RegExp(answer.pattern);
        } catch {
          throw new AnswerError('That pattern is not a valid regular expression.');
        }
        value.pattern = answer.pattern;
      }
      if (answer.enum.length) value.enum = answer.enum;
      if (!Object.keys(value).length) throw new AnswerError('Give at least one limit or allowed value.');
      if (value.minimum !== undefined && value.maximum !== undefined && (value.minimum as number) > (value.maximum as number)) throw new AnswerError('The minimum is above the maximum.');
      const parts = gap.pointer.replace(/^#?\//, '').split('/');
      const last = parts.pop()!;
      return [{ pointer: `#/${[...parts, last].join('/')}`, op: 'merge', value, question: q }];
    }
    case 'example': {
      let value: unknown;
      try {
        value = JSON.parse(answer.body);
      } catch {
        throw new AnswerError('The example is not valid JSON.');
      }
      return [{ pointer: `${gap.pointer}/example`, op: 'set', value, question: q }];
    }
    case 'side_effect':
      return [{ pointer: `${gap.pointer}/x-tb-delete`, op: 'set', value: answer.effect === 'soft' ? { soft: true, field: answer.field || 'status', value: answer.value || 'deleted' } : { soft: false }, question: q }];
    case 'business_rule':
      return answer.text.trim() ? [{ pointer: `${gap.pointer}/x-tb-rules`, op: 'append', value: answer.text.trim(), question: q }] : [];
    case 'dependency':
      return [];
  }
}

/** How ready the spec is for test generation: answered weight over all weight, as a percentage. */
export function readiness(gaps: Gap[], answered: Set<string>): number {
  const total = gaps.reduce((n, g) => n + g.impact, 0);
  if (!total) return 100;
  return Math.round((100 * gaps.filter((g) => answered.has(g.id)).reduce((n, g) => n + g.impact, 0)) / total);
}

import type { Assertion, IntentAnswer, IntentDraft } from '@tb/contracts';
import { API_ASSERTIONS, PAGE_ASSERTIONS } from '@tb/contracts';
import { maskText } from '@tb/platform';
import type { AiContext } from './build';
import { chooseLocator, policyFor } from './locators';

// The model's half of an intent build. It sees the recording with values and page text masked (the
// repo's rule for anything sent to a provider), and what it proposes is only ever a draft for review:
// every check it adds must point at an element the recorder saw, and data rows may only use the
// fields the recording has.

const NEEDS_EXPECTED = new Set<Assertion['kind']>(['text_equals', 'text_contains', 'value_equals', 'count_equals', 'url_contains', 'title_contains']);

export function aiInput(draft: IntentDraft, context: AiContext) {
  const m = (s: string) => maskText(s);
  return {
    title: draft.title,
    intent: { prerequisites: m(draft.intent.prerequisites), intent: m(draft.intent.intent), goal: m(draft.intent.goal) },
    steps: context.steps.map((s) => ({ ...s, value: m(s.value), observed: s.observed.map((o) => ({ ...o, text: m(o.text) })) })),
    end: context.end && { ...context.end, title: m(context.end.title), items: context.end.items.map((o) => ({ ...o, text: m(o.text) })) },
    fields: context.fields.map((f) => ({ ...f, value: m(f.value) })),
    segments: context.segments,
    negative: draft.negative !== null,
  };
}

/** The draft with the model's proposals added, each marked as AI, and what was dropped said in the notes. */
export function applyAnswer(draft: IntentDraft, context: AiContext, answer: IntentAnswer): IntentDraft {
  const policy = policyFor(`${draft.intent.intent} ${draft.intent.goal}`);
  const checks = [...draft.checks];
  let dropped = 0;
  const same = (a: Assertion, b: Assertion) => a.kind === b.kind && a.expected === b.expected && JSON.stringify(a.target ?? null) === JSON.stringify(b.target ?? null);

  for (const c of answer.checks) {
    const step = c.afterStep === null ? null : context.steps[c.afterStep];
    if (c.afterStep !== null && !step) {
      dropped++;
      continue;
    }
    const where = step ? step.where : 'test';
    const stepId = step ? step.stepId : 'goal';
    const pageCheck = PAGE_ASSERTIONS.includes(c.kind);
    const el = pageCheck ? null : context.refs.get(c.observed);
    const loc = el && chooseLocator(el, policy);
    if (API_ASSERTIONS.includes(c.kind) || (!pageCheck && !loc) || (NEEDS_EXPECTED.has(c.kind) && !c.expected)) {
      dropped++;
      continue;
    }
    const assertion: Assertion = { kind: c.kind, soft: false, ...(c.expected ? { expected: c.expected } : {}), ...(loc ? { target: { locator: loc } } : {}) };
    if (checks.some((x) => x.where === where && x.stepId === stepId && same(x.assertion, assertion))) continue;
    const what = loc ? (loc.name ?? loc.value) : '';
    checks.push({
      id: `c${checks.length + 1}`,
      source: 'ai',
      where,
      stepId,
      assertion,
      label: pageCheck ? `${c.kind === 'url_contains' ? 'Address' : 'Page title'} contains "${c.expected}"` : `"${what}" ${c.kind.replace('_', ' ')}${c.expected ? ` "${c.expected}"` : ''}`,
      why: c.why,
    });
  }

  const segments = draft.segments.map((seg) => {
    const named = answer.segments.find((s) => s.key === seg.key);
    // A reused component keeps its name; only new ones take the model's.
    if (!named || seg.reuse) return seg;
    return {
      ...seg,
      component: {
        ...seg.component,
        name: seg.role === 'prerequisite' ? seg.component.name : named.name,
        description: named.purpose,
        meta: { ...seg.component.meta, purpose: named.purpose, leaves: named.leaves || seg.component.meta.leaves },
      },
    };
  });

  const keys = new Set(context.fields.map((f) => f.key));
  const baseRow = draft.valid[0]?.values ?? {};
  const valid = [...draft.valid];
  const invalid = [...draft.invalid];
  for (const r of answer.rows) {
    if (!Object.keys(r.values).every((k) => keys.has(k))) {
      dropped++;
      continue;
    }
    const row = { values: { ...baseRow, ...r.values }, case: r.case, source: 'ai' as const };
    if (r.expect === 'valid') valid.push(row);
    else if (draft.negative) invalid.push(row);
  }

  const notes = [...draft.notes];
  if (dropped) notes.push(`${dropped} AI suggestion${dropped === 1 ? ' was' : 's were'} left out: they pointed at something the recording did not see.`);
  return { ...draft, segments, checks, valid, invalid, notes };
}

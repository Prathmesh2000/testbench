import type { AutoStep, IntentDraft, SaveComponentBody, WorkflowDraft } from '@tb/contracts';
import { ComponentMeta } from '@tb/contracts';
import type { z } from 'zod';
import { withChecks } from './assemble';

type Body = z.infer<typeof SaveComponentBody>;

const DATA_REF = /\{data\.([a-zA-Z_]\w*)\}/g;

/** An address whose path names one thing by its id: a page for something the app made. */
export function madePage(address: string): boolean {
  const path = address.replace(/^\{env\.baseUrl\}/, '').replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0] ?? '';
  return path.split('/').some((seg) => seg && /\d{2,}|^[0-9a-f]{8,}$/i.test(seg));
}

/** The inputs a set of steps reads, wherever they read them: values and locators alike. */
export function inputsOf(steps: AutoStep[]): string[] {
  const keys = new Set<string>();
  for (const st of steps) {
    const loc = st.target && 'locator' in st.target ? st.target.locator : null;
    const texts = [st.value, loc?.value, loc?.name, loc?.within?.value, loc?.within?.name, loc?.within?.hasText, ...st.assertions.map((a) => a.expected)];
    for (const t of texts) for (const m of (t ?? '').matchAll(DATA_REF)) keys.add(m[1]!);
  }
  return [...keys];
}

/**
 * A recording as a workflow: one reusable journey, split at its submit. Every scenario runs `part`,
 * up to and including the submit, whose outcome is what each scenario decides (so it carries no
 * check of its own); valid ones then run `continuation`, what follows (opening what was created).
 */
export function workflowDraft(d: IntentDraft, body: { name: string; intent: string; prerequisiteValues?: Record<string, string> }, prerequisiteId: string | null, startUrl: string | null): WorkflowDraft {
  const steps = d.segments.filter((s) => s.role === 'segment').flatMap((seg) => withChecks(seg.component.steps, seg.key, d, new Set()));
  // A workflow always begins at its own page: every scenario and test run starts it from there,
  // whatever the run before it left on screen. After a prerequisite that lands there, it is a no-op.
  // Except a page of something made earlier (/projects/48213): its address is not there again on the
  // next run, so such a workflow carries on from wherever the one before it left (a journey's previous step).
  if (steps[0]?.action === 'open' && madePage(steps[0].value ?? '')) steps.shift();
  else if (steps[0]?.action !== 'open' && startUrl && !madePage(startUrl))
    steps.unshift({ id: 'start', action: 'open', value: startAddress(startUrl, d.baseUrl), assertions: [], noCheck: true, intent: 'Open the start page' });
  const at = d.submitStepId ? steps.findIndex((s) => s.id === d.submitStepId) : -1;
  const partSteps = (at === -1 ? steps : steps.slice(0, at + 1)).map((s) => (s.id === d.submitStepId ? { ...s, assertions: [], noCheck: true } : s));
  const rest = at === -1 ? [] : steps.slice(at + 1);
  const submit = at === -1 ? null : { stepId: steps[at]!.id, label: submitLabel(steps[at]!) };
  const secretInputs = d.fields.filter((f) => f.secret).map((f) => f.key);
  const kinds = Object.fromEntries(d.fields.map((f) => [f.key, f.kind]));

  const component = (name: string, list: AutoStep[], meta: Partial<ComponentMeta>): Body => {
    const inputs = inputsOf(list);
    return {
      name,
      description: meta.purpose ?? '',
      inputs,
      steps: list,
      changelog: 'Recorded as a workflow',
      meta: ComponentMeta.parse({
        inputKinds: Object.fromEntries(inputs.filter((k) => kinds[k]).map((k) => [k, kinds[k]])),
        defaults: Object.fromEntries(d.fields.filter((f) => inputs.includes(f.key) && !f.secret).map((f) => [f.key, f.recorded])),
        inputRules: Object.fromEntries(d.fields.filter((f) => inputs.includes(f.key)).map((f) => [f.key, f.ruleSet])),
        secretInputs: secretInputs.filter((k) => inputs.includes(k)),
        baseUrl: d.baseUrl,
        ...meta,
      }),
    };
  };

  const pre = d.segments.find((s) => s.role === 'prerequisite' && !s.reuse);
  return {
    name: body.name,
    intent: body.intent,
    prerequisite: pre
      ? component(pre.component.name, withChecks(pre.component.steps, pre.key, d, new Set()), { ...pre.component.meta, origin: 'prerequisite' })
      : null,
    // A recorded prerequisite that matches a saved one is that one.
    prerequisiteId: prerequisiteId ?? d.segments.find((s) => s.role === 'prerequisite' && s.reuse)?.reuse?.id ?? null,
    part: component(body.name, partSteps, {
      // Every value this recording typed, the prerequisite's too, or what a saved prerequisite was run
      // with: one saved before workflows kept values has none, and a test run would otherwise type nothing.
      defaults: { ...body.prerequisiteValues, ...Object.fromEntries(d.fields.filter((f) => !f.secret).map((f) => [f.key, f.recorded])) },
      origin: 'workflow',
      purpose: body.intent,
      intent: body.intent,
      pages: d.pages,
      submitLabel: submit?.label ?? '',
      leaves: submit ? `${submit.label} done` : '',
      tags: ['workflow'],
    }),
    continuation: rest.length
      ? component(`${body.name} · after ${submit!.label}`.slice(0, 120), rest, { origin: 'segment', purpose: `What follows a successful "${submit!.label}".` })
      : null,
    submit,
    fields: d.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind as WorkflowDraft['fields'][number]['kind'], rules: f.ruleSet, recorded: f.recorded, secret: f.secret })),
    pages: d.pages,
    baseUrl: d.baseUrl,
    // Discovery shows what the submit does, scenario by scenario: nothing to ask about it here.
    questions: d.questions.filter((q) => q.id !== 'signal'),
    // A workflow keeps its prerequisite's values itself (prerequisiteValues), so no data set needs them.
    notes: d.notes.filter((n) => !/goal|invalid-input test|in the data sets before running/i.test(n)),
  };
}

/** The page the recording started on, as {env.baseUrl}/path; its query is left out (it may hold typed values). */
function startAddress(url: string, baseUrl: string): string {
  try {
    const u = new URL(url);
    return u.origin === baseUrl || !baseUrl ? `{env.baseUrl}${u.pathname}` : `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function submitLabel(step: AutoStep): string {
  const loc = step.target && 'locator' in step.target ? step.target.locator : null;
  return (loc?.name ?? (loc && loc.strategy !== 'css' ? loc.value : '') ?? '') || (step.action === 'press' ? `press ${step.value ?? 'Enter'}` : 'submit');
}

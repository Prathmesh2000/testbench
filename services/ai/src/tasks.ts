import {
  ApiAskAnswer,
  ApiEnrichDraft,
  ApiExplainAnswer,
  ApiPlanAnswer,
  DraftCases,
  EdgeCases,
  ExtractedRequirements,
  IntentAnswer,
  ScenarioChatAnswer,
  UI_RULES,
  UiReviewAnswer,
  type TestIntent,
  type EnrichmentKind,
  type UiReviewBody,
  type AiTask,
  type DraftCase,
  type EdgeCase,
  type ExtractedRequirement,
} from '@tb/contracts';
import type { z } from 'zod';

// Prompts live here, next to their schemas, and change with the code (HLD §2.3). Each task also has
// a recorded-style mock answer, used in AI_MODE=mock so tests and demos never depend on a model.

export interface RequirementInput {
  document: string;
  requirement: ExtractedRequirement;
  count: number;
  /** Titles of cases already linked, so the model doesn't propose them again. */
  existing: string[];
}
export interface CaseInput {
  title: string;
  preconditions: string;
  steps: { action: string; expected: string }[];
}
export interface DocumentInput {
  title: string;
  body: string;
}

/** A recording as the intent build describes it: values and page text already masked. */
export interface IntentInput {
  title: string;
  intent: TestIntent;
  steps: Array<{ index: number; where: string; action: string; element: string; value: string; page: string; observed: Array<{ ref: string; kind: string; text: string }> }>;
  end: { url: string; title: string; items: Array<{ ref: string; kind: string; text: string }> } | null;
  fields: Array<{ key: string; label: string; kind: string; rules: string; value: string }>;
  segments: Array<{ key: string; name: string; purpose: string; steps: number[] }>;
  /** Whether a negative test exists, so invalid rows are worth proposing. */
  negative: boolean;
}

/** A saved workflow and the conversation about what to test in it; values already masked. */
export interface ScenarioChatInput {
  workflow: {
    name: string;
    intent: string;
    submit: string;
    pages: Array<{ path: string; headings: string[]; messages: string[] }>;
    fields: Array<{ key: string; label: string; kind: string; rules: string; recorded: string }>;
  };
  /** What the tester wants to test, and what they said about each field. */
  testIntent: string;
  validations: Array<{ field: string; required: string; unique: boolean; checks: string[]; message: string; notes: string }>;
  messages: Array<{ role: 'tester' | 'assistant'; text: string }>;
  scenarios: Array<{ id: string; title: string; kind: string; values: Record<string, string>; expect: unknown; seen: string | null }>;
}

/** An API operation, summarised and masked by the API Studio service. */
export interface ApiOperationBrief {
  key: string;
  summary: string;
  inputs: string[];
  outputs: string[];
  security: string[];
  dependsOn: string[];
  feeds: string[];
}

export interface ApiEnrichInput {
  question: { kind: EnrichmentKind; prompt: string; field: string | null };
  operation: ApiOperationBrief;
  /** Field names of the request body, for required-field questions. */
  bodyFields: string[];
  /** Relevant part of the spec as JSON, cut to a few thousand characters. */
  context: string;
}

export interface ApiPlanInput {
  requirement: string;
  /** Chains the planner found valid; the model picks one, it does not invent calls. */
  candidates: Array<{ index: number; steps: string[]; why: string }>;
}

export interface ApiAskInput {
  question: string;
  /** Operations retrieved for the question; the answer may only name these. */
  operations: ApiOperationBrief[];
  last: { status: number | null; security: string[]; auth: string; body: string } | null;
}

export interface TaskInputs {
  generate_cases: RequirementInput;
  edge_cases: CaseInput;
  extract_requirements: DocumentInput;
  intent_test: IntentInput;
  scenario_chat: ScenarioChatInput;
  /** A page's scan, summarised and masked by the studio service. */
  ui_review: UiReviewBody;
  api_enrich: ApiEnrichInput;
  api_explain: { routes: ApiOperationBrief[] };
  api_plan: ApiPlanInput;
  api_ask: ApiAskInput;
}
export interface TaskOutputs {
  generate_cases: { cases: DraftCase[] };
  edge_cases: { edgeCases: EdgeCase[] };
  extract_requirements: { requirements: ExtractedRequirement[] };
  intent_test: IntentAnswer;
  scenario_chat: ScenarioChatAnswer;
  ui_review: UiReviewAnswer;
  api_enrich: z.infer<typeof ApiEnrichDraft>;
  api_explain: z.infer<typeof ApiExplainAnswer>;
  api_plan: z.infer<typeof ApiPlanAnswer>;
  api_ask: z.infer<typeof ApiAskAnswer>;
}

interface TaskDef<K extends AiTask> {
  schema: z.ZodType<TaskOutputs[K]>;
  system: string;
  prompt(input: TaskInputs[K]): string;
  mock(input: TaskInputs[K]): TaskOutputs[K];
}

const SYSTEM =
  'You are a senior QA engineer at an Indian fintech company. You write precise, testable, ' +
  'unambiguous test artefacts in plain British English. Use IST and ₹ where relevant. Never invent ' +
  'product behaviour that the source text does not state.';

// ponytail: long PRDs are cut to this many characters; chunk by section if real PRDs outgrow it.
const MAX_DOC_CHARS = 40_000;

export const TASKS: { [K in AiTask]: TaskDef<K> } = {
  generate_cases: {
    schema: DraftCases,
    system: SYSTEM,
    prompt: (i) =>
      [
        `Write ${i.count} manual test cases for this requirement from the PRD "${i.document}".`,
        `${i.requirement.ref}: ${i.requirement.text}`,
        'Cover the main path first, then negative and boundary behaviour. Each case has a short title ' +
          'starting with a verb (Verify, Check, Validate), a priority (P0 for the core behaviour, P1-P3 ' +
          'for the rest), optional preconditions, and 2-8 steps, each with an action and an expected result.',
        i.existing.length
          ? `These cases already exist; do not repeat them:\n- ${i.existing.join('\n- ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    mock: (i) => ({ cases: mockCases(i) }),
  },
  edge_cases: {
    schema: EdgeCases,
    system: SYSTEM,
    prompt: (i) =>
      [
        'Suggest up to 8 edge cases this test case does not cover yet. For each, give a test title and ' +
          'one sentence on why it matters.',
        `Title: ${i.title}`,
        i.preconditions ? `Preconditions: ${i.preconditions}` : '',
        `Steps:\n${i.steps.map((s, n) => `${n + 1}. ${s.action} → ${s.expected}`).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    mock: (i) => ({ edgeCases: mockEdgeCases(i.title) }),
  },
  intent_test: {
    schema: IntentAnswer,
    system: SYSTEM,
    prompt: (i) =>
      [
        `A tester recorded a test "${i.title}". Refine the draft built from the recording.`,
        `Prerequisites: ${i.intent.prerequisites || '(none)'}\nIntent (what is tested): ${i.intent.intent}\nGoal (what proves it): ${i.intent.goal}`,
        'Steps, each with what appeared on the page right after it (refs in brackets):\n' +
          i.steps
            .map((s) => `${s.index}. [${s.where}] ${s.action} ${s.element}${s.value ? ` = "${s.value}"` : ''} on ${s.page}` +
              s.observed.map((o) => `\n   [${o.ref}] ${o.kind}: ${o.text}`).join(''))
            .join('\n'),
        i.end ? `Final page ${i.end.url} "${i.end.title}":\n${i.end.items.map((o) => `   [${o.ref}] ${o.kind}: ${o.text}`).join('\n')}` : 'No final page was captured.',
        i.fields.length ? `Fields:\n${i.fields.map((f) => `- ${f.key} (${f.label}, ${f.kind}${f.rules ? `, ${f.rules}` : ''}) recorded "${f.value}"`).join('\n')}` : '',
        'Return three things.\n' +
          '1. checks: what proves the intent and the goal. Each follows a step (afterStep = its number) or is a goal check at the end (afterStep = null). ' +
          'Checks on an element must name what appeared by its ref in `observed` (for example "4:0" or "end:1"); never invent an element. ' +
          'url_contains and title_contains need `expected` and no ref. Prefer text_contains on messages and headings; never check values that change per run (counts, prices, dates, ids). ' +
          'Do not repeat the obvious page-change checks; add what the intent is about.\n' +
          '2. segments: for each segment key, a name as a reusable business action (e.g. "Sign in as a buyer", "Search for a city"), ' +
          'a one-sentence purpose, and `leaves`: the state the app is in afterwards.\n' +
          `3. rows: up to 6 extra test data rows using only these field keys: ${i.fields.map((f) => f.key).join(', ') || '(none)'}. ` +
          'Realistic Indian values. Mark each valid or invalid, with a short case saying what it tests.' +
          (i.negative ? '' : ' There is no negative test, so propose valid rows only.'),
      ]
        .filter(Boolean)
        .join('\n\n'),
    // The rules have already done the checks; the recorded answer only names what they could not.
    mock: (i) => ({
      checks: [],
      segments: i.segments.map((s) => ({ key: s.key, name: s.name, purpose: s.purpose || s.name, leaves: '' })),
      rows: [],
    }),
  },
  scenario_chat: {
    schema: ScenarioChatAnswer,
    system:
      SYSTEM +
      ' You are talking with a tester about what to test in a workflow they recorded. Be brief and concrete. ' +
      'When you need something to decide well (what a field accepts, what message the app shows), ask one clear question instead of guessing.',
    prompt: (i) =>
      [
        `Workflow "${i.workflow.name}": ${i.workflow.intent}. It is submitted with "${i.workflow.submit}".`,
        `Fields (use these keys only):\n${i.workflow.fields.map((f) => `- ${f.key}: ${f.label} (${f.kind}${f.rules ? `, ${f.rules}` : ''}), recorded "${f.recorded}"`).join('\n') || '(none)'}`,
        `Pages:\n${i.workflow.pages.map((p) => `- ${p.path}: ${p.headings.join(' / ')}${p.messages.length ? ` · seen: ${p.messages.join(' | ')}` : ''}`).join('\n')}`,
        `What the tester wants to test: ${i.testIntent || '(not said yet)'}`,
        `Field validation the tester agreed:\n${i.validations.map((v) => `- ${v.field}: required ${v.required}${v.unique ? ', must be unique' : ''}; checks ${v.checks.join('; ') || 'none'}${v.message ? `; error text "${v.message}"` : ''}${v.notes ? `; notes: ${v.notes}` : ''}`).join('\n') || '(none)'}`,
        `Scenarios so far:\n${i.scenarios.map((s) => `- [${s.id}] ${s.title} (${s.kind}) values ${JSON.stringify(s.values)} expects ${JSON.stringify(s.expect)}${s.seen ? ` · the app did: ${s.seen}` : ''}`).join('\n') || '(none)'}`,
        `Conversation:\n${i.messages.map((m) => `${m.role === 'tester' ? 'Tester' : 'You'}: ${m.text}`).join('\n') || '(just started)'}`,
        'Reply to the tester\'s last message, then give the full scenario list as it should now stand (keep the ids of scenarios you keep). ' +
          'For each scenario settle the validation: outcome success or rejected; the toast or message expected (empty if none or unknown); ' +
          'inline errors by field key with their text when known; the page after submit (moves_on, stays or any); the dialog (closes, stays_open or any). ' +
          'Only what the tester wants tested: keep the scenarios built from their field checks, and add one only where their intent needs it and those miss it; never add unrelated ones. ' +
          'A value may contain {unique}, replaced at run time by a new 8-character value for fields the app keeps unique: keep it as it is. ' +
          'Never set a value a field of type number or date cannot hold, nor one longer than a field\'s max: the browser cuts it there, so the app never sees it; test the max itself instead. Where the app already showed what it does ("the app did"), follow it unless the tester says the app is wrong.',
      ].join('\n\n'),
    mock: (i) => ({
      reply: i.scenarios.length
        ? `There are ${i.scenarios.length} scenarios, from the fields' rules. Tell me what else matters, or run them to see what the app does.`
        : 'Tell me what matters in this workflow and I will propose scenarios.',
      scenarios: i.scenarios.map((s) => ({ ...s, kind: s.kind as ScenarioChatAnswer['scenarios'][number]['kind'], expect: s.expect as ScenarioChatAnswer['scenarios'][number]['expect'] })),
    }),
  },
  ui_review: {
    schema: UiReviewAnswer,
    system:
      SYSTEM +
      ' You also review web UIs as a senior UI designer and accessibility specialist. You only have measurements of the page, ' +
      'not a picture of it: never claim how something looks beyond what the numbers show.',
    prompt: (i) => {
      const list = (rows: Array<{ value: string; count: number }>) => rows.map((r) => `${r.value} ×${r.count}`).join(', ') || '(none)';
      const ms = (v: number | null) => (v === null ? 'n/a' : `${v} ms`);
      return [
        `Review the UI of "${i.title}" (${i.url}) on ${i.device}, viewport ${i.viewport.width}×${i.viewport.height}.`,
        i.focus ? `The tester wants the review to focus on: ${i.focus}` : '',
        `Elements scanned: ${i.stats.elements}. By kind: ${list(i.stats.kinds)}.`,
        `Font families: ${list(i.stats.fonts)}\nFont sizes (px): ${list(i.stats.sizes)}\nFont weights: ${list(i.stats.weights)}`,
        `Text colours: ${list(i.stats.colours)}\nBackgrounds: ${list(i.stats.backgrounds)}\nCorner radii: ${list(i.stats.radii)}`,
        `Headings, buttons and fields:\n${i.sample.map((s) => `- ${s.kind} ${s.element}: ${s.font}, ${s.colour} on ${s.background}, ${s.size}, radius ${s.radius}`).join('\n') || '(none)'}`,
        `Accessibility issues found by rule:\n${i.issues.map((x) => `- ${x.rule} (${UI_RULES[x.rule].title}, WCAG ${UI_RULES[x.rule].wcag}) ×${x.count}, e.g. ${x.example}`).join('\n') || '(none)'}`,
        `Performance: TTFB ${ms(i.perf.ttfb)}, FCP ${ms(i.perf.fcp)}, LCP ${ms(i.perf.lcp)}, CLS ${i.perf.cls ?? 'n/a'}, TBT ${ms(i.perf.tbt)}, load ${ms(i.perf.load)}, ` +
          `${i.perf.requests} requests, ${Math.round(i.perf.bytes / 1024)} KB, ${i.perf.domNodes} DOM nodes (depth ${i.perf.domDepth}).`,
        i.findings.length ? `The tester already found these; do not repeat them:\n${i.findings.map((f) => `- ${f.title}${f.element ? ` (${f.element})` : ''}${f.note ? `: ${f.note}` : ''}`).join('\n')}` : '',
        'Give a two or three sentence summary, then up to 15 concrete suggestions, most important first. Each names its area, a severity ' +
          '(high: blocks users or fails WCAG A/AA; medium: visible inconsistency or slow; low: polish), a short title starting with a verb, ' +
          'and a detail that says what to change and to what (for example "use 14 px and 16 px only; 13 px and 15 px appear 3 times"). ' +
          'Where a suggestion is about one element, set `element` to it exactly as named above. Look for inconsistency above all: ' +
          'near-duplicate sizes and colours, a type scale that is not a scale, buttons that differ in size or radius.',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    mock: (i) => ({
      summary: `${i.stats.elements} elements on "${i.title}", ${i.issues.reduce((n, x) => n + x.count, 0)} accessibility issues across ${i.issues.length} rules. This is a recorded answer: connect an AI provider for a real review.`,
      suggestions: i.issues.slice(0, 10).map((x) => ({
        area: 'accessibility' as const,
        severity: UI_RULES[x.rule].severity === 'critical' || UI_RULES[x.rule].severity === 'serious' ? ('high' as const) : ('medium' as const),
        title: `Fix ${x.count} × ${UI_RULES[x.rule].title.toLowerCase()}`,
        detail: `WCAG ${UI_RULES[x.rule].wcag}. For example: ${x.example}`,
        element: '',
      })),
    }),
  },
  api_enrich: {
    schema: ApiEnrichDraft,
    system: SYSTEM + ' You fill gaps in API specifications. Only state what the spec and its context imply; when you are guessing, say so in `why`.',
    prompt: (i) =>
      [
        `Question about ${i.operation.key} (${i.operation.summary || 'no summary'}): ${i.question.prompt}`,
        `Kind of answer: ${i.question.kind}${i.question.field ? `, for the field ${i.question.field}` : ''}.`,
        `Inputs: ${i.operation.inputs.join(', ') || 'none'}. Body fields: ${i.bodyFields.join(', ') || 'none'}. Outputs: ${i.operation.outputs.slice(0, 30).join(', ') || 'none'}. Security: ${i.operation.security.join(', ') || 'none declared'}.`,
        `Spec context:\n${i.context}`,
        'Answer with the most likely value in the shape the kind requires, and one or two sentences on why.',
      ].join('\n\n'),
    mock: (i) => ({ answer: mockEnrich(i), why: 'A recorded answer from the rules of thumb for this kind of gap: connect an AI provider for one based on the spec.' }),
  },
  api_explain: {
    schema: ApiExplainAnswer,
    system: SYSTEM + ' You explain HTTP APIs to testers: what each route is for and what to test. Never describe routes that are not listed.',
    prompt: (i) =>
      [
        'Explain each of these routes: its purpose in one sentence, up to 8 things to test (happy path, validation, auth, not found, boundaries, side effects), and gaps in what is documented.',
        i.routes
          .map((r) => `- ${r.key}: ${r.summary || '(no summary)'}; inputs ${r.inputs.join(', ') || 'none'}; returns ${r.outputs.slice(0, 20).join(', ') || 'nothing documented'}; security ${r.security.join(', ') || 'none'}; needs ${r.dependsOn.join(', ') || 'nothing'}; feeds ${r.feeds.join(', ') || 'nothing'}`)
          .join('\n'),
        'Use each route key exactly as written.',
      ].join('\n\n'),
    mock: (i) => ({
      routes: i.routes.map((r) => ({
        key: r.key,
        purpose: r.summary || `${r.key.split(' ')[0]} ${r.key.split(' ')[1]}`,
        whatToTest: mockWhatToTest(r),
        gaps: [...(r.security.length ? [] : ['Security is not declared.']), ...(r.outputs.length ? [] : ['The response body is not described.'])],
      })),
    }),
  },
  api_plan: {
    schema: ApiPlanAnswer,
    system: SYSTEM + ' You match requirements to API calls. You may only choose among the numbered chains; never invent calls.',
    prompt: (i) =>
      [
        `Requirement: ${i.requirement}`,
        `Chains of calls that work:\n${i.candidates.map((c) => `${c.index}. ${c.steps.join(' → ')} (${c.why})`).join('\n') || '(none)'}`,
        'Pick the chain that best meets the requirement and explain in two or three sentences how it does. If none does, answer -1. List parts of the requirement no chain covers as gaps.',
      ].join('\n\n'),
    mock: (i) => ({
      chosen: i.candidates.length ? i.candidates[0]!.index : -1,
      explanation: i.candidates.length ? `The first matching chain, ${i.candidates[0]!.steps.join(' → ')}, covers the words of the requirement best. This is a recorded answer.` : 'No chain of documented calls matches this requirement.',
      gaps: [],
    }),
  },
  api_ask: {
    schema: ApiAskAnswer,
    system: SYSTEM + ' You answer questions about a project’s APIs using only the operations listed. Name operations by their key exactly.',
    prompt: (i) =>
      [
        `Question: ${i.question}`,
        `Operations:\n${i.operations.map((o) => `- ${o.key}: ${o.summary || ''}; inputs ${o.inputs.join(', ') || 'none'}; security ${o.security.join(', ') || 'none'}`).join('\n') || '(none found)'}`,
        i.last ? `The tester's last response: status ${i.last.status ?? 'none'}, sent with ${i.last.auth}, operation security ${i.last.security.join(', ') || 'none'}.\nBody: ${i.last.body}` : '',
        'Answer in at most five sentences and list the operations you mention.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    mock: (i) => ({
      answer: i.last?.status === 403 || i.last?.status === 401
        ? `A ${i.last.status} usually means the credential was missing, expired or lacks the role this operation needs (${i.last.security.join(', ') || 'no scheme declared'}). Check the auth tab and the profile's role. This is a recorded answer.`
        : i.operations.length
          ? `${i.operations[0]!.key} looks like the closest match${i.operations[0]!.summary ? `: ${i.operations[0]!.summary}` : ''}. This is a recorded answer.`
          : 'No documented operation matches. This is a recorded answer.',
      operations: i.operations.slice(0, 3).map((o) => o.key),
    }),
  },
  extract_requirements: {
    schema: ExtractedRequirements,
    system: SYSTEM,
    prompt: (i) =>
      [
        `Extract every testable requirement from the PRD "${i.title}".`,
        'Keep the document’s own requirement ids when it has them; otherwise number them REQ-1, REQ-2… ' +
          'in document order. The title is a short summary (under 80 characters); the text is the ' +
          'requirement as the document states it. Skip background, goals and non-testable prose.',
        `PRD:\n"""\n${i.body.slice(0, MAX_DOC_CHARS)}\n"""`,
      ].join('\n\n'),
    mock: (i) => ({ requirements: sentenceRequirements(i.body) }),
  },
};

/** Sentences that read like requirements ("… must/can/shall …"), numbered in document order. */
export function sentenceRequirements(body: string): ExtractedRequirement[] {
  const sentences = body
    .split(/\n+/)
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.replace(/^[\s*\-\d.)]+/, '').trim())
    .filter(
      (s) => s.length > 15 && /\b(must|shall|should|can|cannot|will|is sent|are sent|requires?)\b/i.test(s),
    );
  return sentences.slice(0, 300).map((text, n) => ({ ref: `REQ-${n + 1}`, title: summarise(text), text }));
}

function summarise(text: string): string {
  const clean = text.replace(/^(A|An|The)\s+/i, '').replace(/[.]$/, '');
  return clean.length <= 80 ? clean : `${clean.slice(0, 77).trimEnd()}…`;
}

function mockCases(i: RequirementInput): DraftCase[] {
  const subject = summarise(i.requirement.text).replace(/^\w/, (c) => c.toLowerCase());
  const variants: DraftCase[] = [
    {
      title: `Verify ${subject}`,
      priority: 'P0',
      preconditions: 'Signed-in customer with a verified account',
      steps: [
        {
          action: 'Open the feature described in the requirement',
          expected: 'The screen loads without errors',
          data: '',
        },
        { action: 'Complete the main flow with valid data', expected: i.requirement.text, data: '' },
      ],
    },
    {
      title: `Check ${subject} rejects invalid input`,
      priority: 'P1',
      preconditions: '',
      steps: [
        {
          action: 'Start the flow with invalid or missing data',
          expected: 'A clear validation message is shown',
          data: '',
        },
        {
          action: 'Correct the data and retry',
          expected: 'The flow completes as the requirement states',
          data: '',
        },
      ],
    },
    {
      title: `Validate boundary values for ${subject}`,
      priority: 'P1',
      preconditions: '',
      steps: [
        { action: 'Use the lowest allowed value', expected: 'Accepted', data: '' },
        { action: 'Use the highest allowed value', expected: 'Accepted', data: '' },
        { action: 'Use one step beyond the highest value', expected: 'Rejected with a message', data: '' },
      ],
    },
    {
      title: `Check ${subject} after a network drop`,
      priority: 'P2',
      preconditions: 'Network throttling available in the test device',
      steps: [
        {
          action: 'Start the flow and cut the network midway',
          expected: 'The user is told the action did not complete',
          data: '',
        },
        { action: 'Restore the network and retry', expected: 'No duplicate action is created', data: '' },
      ],
    },
    {
      title: `Verify ${subject} in Hindi locale`,
      priority: 'P3',
      preconditions: 'App language set to Hindi',
      steps: [
        {
          action: 'Complete the main flow',
          expected: 'All messages appear in Hindi and nothing is truncated',
          data: '',
        },
      ],
    },
  ];
  const fresh = variants.filter((v) => !i.existing.includes(v.title));
  return (fresh.length ? fresh : variants).slice(0, i.count);
}

function mockEdgeCases(title: string): EdgeCase[] {
  const t = title.replace(/^(Verify|Check|Validate)\s+/i, '');
  return [
    {
      title: `${t} with a double tap on submit`,
      why: 'Duplicate submissions are a common cause of double debits.',
    },
    {
      title: `${t} across the midnight IST boundary`,
      why: 'Date-based rules often break when the day changes mid-flow.',
    },
    {
      title: `${t} after the session expires`,
      why: 'The user should be asked to sign in again without losing their input.',
    },
    {
      title: `${t} on a slow 2G connection`,
      why: 'Timeouts and retries behave differently on poor networks.',
    },
    {
      title: `${t} with the maximum field lengths`,
      why: 'Long names and addresses expose truncation and layout bugs.',
    },
  ];
}

function mockEnrich(i: ApiEnrichInput): z.infer<typeof ApiEnrichDraft>['answer'] {
  switch (i.question.kind) {
    case 'security':
      return { kind: 'security', scheme: /login|token|signin|register|health/i.test(i.operation.key) ? null : 'bearer', roles: [] };
    case 'error_response':
      return { kind: 'error_response', status: i.operation.key.startsWith('GET') ? '404' : '400', description: 'Invalid request', body: JSON.stringify({ error: 'invalid request' }) };
    case 'required':
      return { kind: 'required', fields: i.bodyFields.filter((f) => /id$|name|email|amount|qty|quantity/i.test(f)) };
    case 'constraints':
      return /qty|quantity|count|amount|age|limit/i.test(i.question.field ?? '')
        ? { kind: 'constraints', minimum: 1, maximum: 1000, maxLength: null, pattern: '', enum: [] }
        : { kind: 'constraints', minimum: null, maximum: null, maxLength: 255, pattern: '', enum: [] };
    case 'dependency':
      return { kind: 'dependency', confirmed: true };
    case 'example':
      return { kind: 'example', body: JSON.stringify(Object.fromEntries(i.bodyFields.map((f) => [f, /id$/i.test(f) ? 'id_123' : /email/i.test(f) ? 'tester@example.com' : /qty|amount|count/i.test(f) ? 1 : 'sample'])), null, 2) };
    case 'side_effect':
      return { kind: 'side_effect', effect: 'hard', field: '', value: '' };
    case 'business_rule':
      return { kind: 'business_rule', text: '' };
  }
}

function mockWhatToTest(r: ApiOperationBrief): string[] {
  const [method] = r.key.split(' ');
  const out = ['Happy path with valid inputs returns success'];
  if (r.inputs.length) out.push(`Missing or invalid ${r.inputs.slice(0, 3).join(', ')} is refused`);
  if (r.security.length) out.push('No or expired credential gets 401; wrong role gets 403');
  if (/\{/.test(r.key)) out.push('An unknown id gets 404');
  if (method === 'POST') out.push('Creating the same thing twice is handled (409 or idempotent)');
  if (method === 'DELETE') out.push('After deleting, reading it back gets 404');
  if (r.dependsOn.length) out.push(`Set up first with ${r.dependsOn.slice(0, 2).join(', ')}`);
  return out;
}

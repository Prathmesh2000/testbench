import {
  DraftCases,
  EdgeCases,
  ExtractedRequirements,
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

export interface TaskInputs {
  generate_cases: RequirementInput;
  edge_cases: CaseInput;
  extract_requirements: DocumentInput;
}
export interface TaskOutputs {
  generate_cases: { cases: DraftCase[] };
  edge_cases: { edgeCases: EdgeCase[] };
  extract_requirements: { requirements: ExtractedRequirement[] };
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

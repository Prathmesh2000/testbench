import { z } from 'zod';
import { RecordedStep } from './browser';
import type { DraftQuestion } from './intent';
import { Assertion, FIELD_KINDS, type ComponentMeta, type FieldKind, type FieldRules, type PageInfo, type SaveComponentBody } from './studio';

// Workflows (testing-studio-plan §3.3): a journey recorded once, after its prerequisite, saved with
// its meta and the pages it goes through, then tested with many scenarios agreed in a chat and
// checked against what the app really does (a discovery run of each) before tests are made.

export const WorkflowDraftBody = z.object({
  name: z.string().trim().min(2).max(120),
  /** What the workflow does, in the tester's words. */
  intent: z.string().trim().min(3).max(2000),
  /** A saved workflow that must run first; or `prerequisite` recorded now, or neither. */
  prerequisiteComponentId: z.uuid().nullable().default(null),
  prerequisite: z.array(RecordedStep).max(500).default([]),
  /** What the tester ran a saved prerequisite with (not its secrets): the tests run it the same way. */
  prerequisiteValues: z.record(z.string().max(64), z.string().max(4_000)).default({}),
  recording: z.array(RecordedStep).min(1).max(1_000),
  answers: z.record(z.string().max(64), z.string().max(500)).default({}),
});
export type WorkflowDraftBody = z.infer<typeof WorkflowDraftBody>;

/** A field a scenario can fill, with its rules and what the recording typed. */
export interface WorkflowField {
  key: string;
  label: string;
  kind: FieldKind;
  rules: FieldRules;
  /** What was typed while recording; empty for a secret or a field left empty. */
  recorded: string;
  secret: boolean;
}

export interface WorkflowDraft {
  name: string;
  intent: string;
  /** A prerequisite recorded now, to be saved as its own workflow; null when chosen or none. */
  prerequisite: z.infer<typeof SaveComponentBody> | null;
  prerequisiteId: string | null;
  /** The journey up to and including its submit: every scenario runs this far. */
  part: z.infer<typeof SaveComponentBody>;
  /** What follows a successful submit (open what was created); run by valid scenarios only. */
  continuation: z.infer<typeof SaveComponentBody> | null;
  submit: { stepId: string; label: string } | null;
  fields: WorkflowField[];
  pages: PageInfo[];
  /** The site it was recorded on: where discovery runs and the default for test runs. */
  baseUrl: string;
  questions: DraftQuestion[];
  notes: string[];
}

export const WorkflowSaveBody = z.object({
  draft: z.custom<WorkflowDraft>((v) => !!v && typeof v === 'object'),
});

/** A saved workflow, as the Workflows screen and the scenario chat use it. */
export interface Workflow {
  id: string;
  name: string;
  version: number;
  intent: string;
  purpose: string;
  prerequisite: { id: string; name: string; version: number; inputs: string[]; inputKinds: Record<string, FieldKind> } | null;
  continuation: { id: string; version: number; inputs: string[] } | null;
  inputs: string[];
  fields: WorkflowField[];
  pages: PageInfo[];
  /** The workflow's own steps, by id: where a negative scenario may be expected to stop. */
  steps: Array<{ id: string; label: string; action: string }>;
  /** The APIs its recording called. */
  apis: ComponentMeta['apis'];
  baseUrl: string;
  submitLabel: string;
  updatedAt: string;
}

// ---------- scenarios ----------

export const SCENARIO_KINDS = ['positive', 'negative', 'boundary', 'edge'] as const;

/** What the page did, as a discovery run saw it (PageSnapshot in browser.ts). */
export const Seen = z.object({
  url: z.string().max(4_000),
  title: z.string().max(300),
  dialogs: z.array(z.string().max(120)).max(5),
  messages: z.array(z.string().max(300)).max(10),
  fieldErrors: z.array(z.object({ field: z.string().max(200), message: z.string().max(300), source: z.enum(['native', 'page']) })).max(30),
  /** A step failed before the submit (say, a value a field would not take). */
  failed: z.string().max(500).nullable().default(null),
  /** The step the run could not get past, and why: its element was disabled, was not there, or another error. */
  stoppedAt: z.object({ stepId: z.string().max(60), kind: z.enum(['disabled', 'missing', 'error']) }).nullable().default(null),
  /** Cookies and storage after the run (values masked where secret), and the APIs it called. */
  storage: z.array(z.object({ area: z.enum(['cookie', 'local', 'session']), key: z.string().max(300), value: z.string().max(500) })).max(100).default([]),
  apis: z.array(z.object({ method: z.string().max(10), path: z.string().max(500), status: z.number().int().nullable() })).max(60).default([]),
});
export type Seen = z.infer<typeof Seen>;

/** What must be true after the submit for the scenario to pass. */
export const Expectation = z.object({
  outcome: z.enum(['success', 'rejected']),
  /** The toast or message expected; empty when none is. */
  message: z.string().max(300).default(''),
  /** Inline errors, by field key: the browser's own message (`native`) or the app's text on the page. */
  fieldErrors: z
    .array(z.object({ field: z.string().max(60), message: z.string().max(300), source: z.enum(['native', 'page']).default('page') }))
    .max(20)
    .default([]),
  /** After the submit: the page moves on to another address, or stays where it is. */
  page: z.enum(['moves_on', 'stays', 'any']).default('any'),
  /** The form's dialog, when it has one. */
  dialog: z.enum(['closes', 'stays_open', 'any']).default('any'),
  /**
   * A refusal before the submit: the workflow runs as far as this step, which must be disabled (a submit
   * the form keeps off while a field is invalid) or not there. Null: the whole workflow runs.
   */
  stop: z.object({ stepId: z.string().max(60), kind: z.enum(['disabled', 'missing']) }).nullable().default(null),
  /** Also checked after the submit: a cookie or storage key (and value), an API call and its status. */
  checks: z.array(Assertion).max(20).default([]),
});
export type Expectation = z.infer<typeof Expectation>;

export const Scenario = z.object({
  id: z.string().min(1).max(40),
  title: z.string().trim().min(2).max(200),
  kind: z.enum(SCENARIO_KINDS),
  /** A value for each workflow input the scenario sets; the rest keep their recorded value. */
  values: z.record(z.string(), z.string().max(4_000)),
  expect: Expectation,
  seen: Seen.nullable().default(null),
  /** draft: proposed · seen: a discovery run has shown what the app does · confirmed: agreed by the tester. */
  status: z.enum(['draft', 'seen', 'confirmed']).default('draft'),
  source: z.enum(['rule', 'ai', 'tester']).default('rule'),
});
export type Scenario = z.infer<typeof Scenario>;

// ---------- what to test: the tester's intent and each field's validation ----------

/** A value worth trying in a field, and whether the app should take it. */
export const FieldCheck = z.object({
  id: z.string().min(1).max(60),
  label: z.string().trim().min(2).max(200),
  outcome: z.enum(['success', 'rejected']),
  value: z.string().max(4_000),
});
export type FieldCheck = z.infer<typeof FieldCheck>;

/** What the page says about a field, and the checks its type, role and rules suggest. */
export interface FieldCheckOffer {
  key: string;
  label: string;
  kind: FieldKind;
  /** The field carries `required` (or aria-required) in the page. */
  domRequired: boolean;
  /** Its rules as the page states them, in words: "at most 60 characters", "type email". */
  facts: string[];
  /** Its name suggests the app refuses a value already used (a name, an email, a code). */
  uniqueLikely: boolean;
  suggestions: Array<FieldCheck & { why: string; selected: boolean; when: 'always' | 'required' | 'optional' | 'unique' }>;
}

/** The tester's answer for one field. */
export const FieldValidation = z.object({
  key: z.string().min(1).max(60),
  required: z.enum(['yes', 'no', 'unknown']),
  /** Already used values are refused: every scenario but the duplicate one gets a {unique} value. */
  unique: z.boolean().default(false),
  checks: z.array(FieldCheck).max(30).default([]),
  /** The error the app shows for this field, when the tester knows it. */
  message: z.string().max(300).default(''),
  notes: z.string().max(500).default(''),
});
export type FieldValidation = z.infer<typeof FieldValidation>;

export const ScenarioBuildBody = z.object({
  /** What the tester wants to test, in their words. */
  intent: z.string().trim().min(3).max(2000),
  validations: z.array(FieldValidation).max(40),
});
export type ScenarioBuildBody = z.infer<typeof ScenarioBuildBody>;

/**
 * What a tester has settled for a workflow, saved with it so anyone can pick it up: what to test,
 * each field's validation, the chat, the scenarios with what the app did, and checks added for every
 * success (from the site map, say: "POST /api/projects answers 201", "cookie session is set").
 */
export const WorkflowPlan = z.object({
  intent: z.string().max(2000).default(''),
  validations: z.array(FieldValidation).max(40).default([]),
  messages: z.array(z.object({ role: z.enum(['tester', 'assistant']), text: z.string().max(4_000) })).max(60).default([]),
  scenarios: z.array(Scenario).max(60).default([]),
  checks: z.array(Assertion).max(20).default([]),
});
export type WorkflowPlan = z.infer<typeof WorkflowPlan>;

/** Replaced at run time by a value of the same length that is new on every run. */
export const UNIQUE_TOKEN = '{unique}';

export const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(['tester', 'assistant']), text: z.string().max(4_000) })).max(60),
  scenarios: z.array(Scenario).max(60),
  /** What the tester said to test and each field's validation, so the chat stays on them. */
  intent: z.string().max(2000).default(''),
  validations: z.array(FieldValidation).max(40).default([]),
});
export type ChatBody = z.infer<typeof ChatBody>;

export interface ChatAnswer {
  reply: string;
  scenarios: Scenario[];
  ai: { status: 'used' | 'unavailable' | 'off'; message: string | null };
}

/** The model's turn: a reply, and the whole scenario list as it should now stand. */
export const ScenarioChatAnswer = z.object({
  reply: z.string().max(4_000),
  scenarios: z
    .array(
      z.object({
        id: z.string().max(40).optional(),
        title: z.string().min(2).max(200),
        kind: z.enum(SCENARIO_KINDS),
        values: z.record(z.string(), z.string().max(4_000)).default({}),
        expect: z.object({
          outcome: z.enum(['success', 'rejected']),
          message: z.string().max(300).default(''),
          fieldErrors: z.array(z.object({ field: z.string().max(60), message: z.string().max(300) })).max(20).default([]),
          page: z.enum(['moves_on', 'stays', 'any']).default('any'),
          dialog: z.enum(['closes', 'stays_open', 'any']).default('any'),
        }),
      }),
    )
    .max(30),
});
export type ScenarioChatAnswer = z.infer<typeof ScenarioChatAnswer>;

export const GenerateTestsBody = z.object({
  title: z.string().trim().min(3).max(160),
  scenarios: z.array(Scenario).min(1).max(60),
});

export interface GeneratedTests {
  tests: Array<{ id: string; key: string; title: string; rows: number; scenarios: string[] }>;
  dataSetIds: string[];
}

export { FIELD_KINDS };

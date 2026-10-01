import { z } from 'zod';
import { RecordedStep } from './browser';
import { ASSERTIONS, type Assertion, type AutoStep, type FieldRules, type PageInfo, type SaveComponentBody, TestIntent } from './studio';

// Intent-driven test building (testing-studio-plan §3.3): the tester says what must be true first
// (prerequisites), what they are testing (intent) and what proves it (goal), and records it once.
// The build turns that into reusable segments with their meta, checks, and data variations, as a
// draft to review; committing saves it as components, data sets and tests in one go.

/** A recording to build from. Its own file: it needs both the step model and the recorder's shapes. */
export const IntentBuildBody = z.object({
  title: z.string().trim().min(3).max(200),
  intent: TestIntent,
  /** A saved component that already sets up the prerequisites; used instead of recording them. */
  prerequisiteComponentId: z.uuid().nullable().default(null),
  /** The prerequisites as recorded, when no saved component fits; becomes its own component. */
  prerequisite: z.array(RecordedStep).max(500).default([]),
  recording: z.array(RecordedStep).min(1).max(1_000),
  /** Off: rules only. On: the configured model refines the rules' draft, when it is reachable. */
  useAi: z.boolean().default(true),
  /** The tester's answers to the draft's questions, by question id; the build is run again with them. */
  answers: z.record(z.string().max(64), z.string().max(500)).default({}),
});
export type IntentBuildBody = z.infer<typeof IntentBuildBody>;

/** One check the build proposes, kept apart from the steps so the tester can accept or drop it. */
export interface DraftCheck {
  id: string;
  /** `rule`: seen on the page while recording. `ai`: proposed by the model from the intent. */
  source: 'rule' | 'ai';
  /** Where it goes: a segment's key, `test`, or `negative`. */
  where: string;
  stepId: string;
  assertion: Assertion;
  /** In words, for the review list. */
  label: string;
  why: string;
}

export interface DraftSegment {
  key: string;
  role: 'prerequisite' | 'segment';
  /** Stands in for the component's id in the tests' steps until the commit creates it. */
  placeholderId: string;
  /** An existing component that already does this; the commit uses it instead of creating one. */
  reuse: { id: string; name: string; version: number; why: string } | null;
  /** Component input → the test's data key (or secret) that fills it. */
  bindings: Record<string, string>;
  component: z.infer<typeof SaveComponentBody>;
}

/**
 * Something the build could not work out from the recording and will not guess: it asks the tester,
 * and saving waits until every required question is answered.
 */
export interface DraftQuestion {
  id: string;
  text: string;
  /** Why it matters, in a sentence. */
  why: string;
  /** Pick one of `options`, or type an answer (`text`), where allowed. */
  options: Array<{ value: string; label: string }>;
  allowText: boolean;
  /** A placeholder for the typed answer. */
  textHint: string;
  required: boolean;
  /** The answer given, when the build was re-run with it. */
  answer: string | null;
}

export interface DraftDataField {
  key: string;
  label: string;
  kind: string;
  rules: string;
  /** The same rules, whole, and what the recording typed (empty for a secret). */
  ruleSet: FieldRules;
  recorded: string;
  secret: boolean;
}

export interface DraftRow {
  values: Record<string, string>;
  /** What this row tests, e.g. "Mobile number with 9 digits". */
  case: string;
  source: 'recorded' | 'rule' | 'ai';
}

export interface IntentDraft {
  title: string;
  intent: TestIntent;
  segments: DraftSegment[];
  /** The main test: segments in order, then the goal checks. */
  test: { title: string; steps: AutoStep[]; secrets: string[] };
  /** The same journey with invalid data, expecting the goal not to be reached; null without form input. */
  negative: { title: string; steps: AutoStep[]; secrets: string[] } | null;
  fields: DraftDataField[];
  valid: DraftRow[];
  invalid: DraftRow[];
  checks: DraftCheck[];
  /** What the build needs the tester to decide; unanswered required ones block saving. */
  questions: DraftQuestion[];
  /** The step that submits the journey's form, when there is one. */
  submitStepId: string | null;
  /** The site it was recorded on. */
  baseUrl: string;
  /** What the recording went through, page by page. */
  pages: PageInfo[];
  /** What the build could not do, or chose not to, in plain words. */
  notes: string[];
  ai: { status: 'used' | 'unavailable' | 'off'; message: string | null };
}

export const IntentCommitBody = z.object({
  draft: z.custom<IntentDraft>((v) => !!v && typeof v === 'object'),
  /** Checks the tester dropped in review. */
  rejectedChecks: z.array(z.string().max(64)).max(500).default([]),
  /** Rows the tester dropped, by list and index. */
  rejectedRows: z.array(z.object({ list: z.enum(['valid', 'invalid']), index: z.number().int().min(0) })).max(500).default([]),
  /** Segment names and purposes as edited in review, by segment key. */
  renamed: z.record(z.string(), z.object({ name: z.string().trim().min(2).max(120), purpose: z.string().trim().max(500) })).default({}),
});
export type IntentCommitBody = z.infer<typeof IntentCommitBody>;

export interface IntentCommitResult {
  testId: string;
  negativeTestId: string | null;
  componentIds: string[];
  dataSetIds: string[];
}

// ---------- the AI task: refines the rules' draft, never replaces the page's facts ----------

/** Kinds of check the model may propose; each points at something the recorder saw, never a made-up locator. */
const AiCheckKind = z.enum(ASSERTIONS.filter((k) => k !== 'status_equals') as [Assertion['kind'], ...Assertion['kind'][]]);

export const IntentAnswer = z.object({
  checks: z
    .array(
      z.object({
        /** Index of the step it follows; null for the goal checks at the end. */
        afterStep: z.number().int().min(0).nullable(),
        kind: AiCheckKind,
        /** Which observed item it checks, as "<step>:<item>" or "end:<item>"; empty for page checks. */
        observed: z.string().max(20).default(''),
        expected: z.string().max(300).optional(),
        why: z.string().max(300),
      }),
    )
    .max(20),
  segments: z
    .array(z.object({ key: z.string().max(20), name: z.string().min(2).max(80), purpose: z.string().max(300), leaves: z.string().max(200) }))
    .max(20),
  rows: z
    .array(z.object({ values: z.record(z.string(), z.string().max(500)), expect: z.enum(['valid', 'invalid']), case: z.string().max(200) }))
    .max(12),
});
export type IntentAnswer = z.infer<typeof IntentAnswer>;

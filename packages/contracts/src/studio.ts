import { z } from 'zod';

// Testing Studio automation (testing-studio-plan §3–§5). A test is structured steps, not code: the
// steps are the source of truth and Playwright code is generated from a pinned version at run time.

// ---------- locators ----------

/** In order of preference; XPath is deliberately absent (fragile, and blocked in no-code tests). */
export const LOCATOR_STRATEGIES = ['testid', 'role', 'label', 'placeholder', 'text', 'css'] as const;
export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

const LocatorBase = z.object({
  strategy: z.enum(LOCATOR_STRATEGIES),
  /** Test id, ARIA role, label text, placeholder, visible text, or CSS selector. */
  value: z.string().trim().min(1).max(500),
  /** Accessible name, only for the `role` strategy. */
  name: z.string().trim().max(200).optional(),
});

/**
 * How to find one element. When the same button appears in every row of a table, `within` says which
 * row: "the Add button inside the row that says Dell XPS". That reads like the tester's intent and
 * survives reordering, which a positional selector does not. `nth` is the last resort for lists with
 * nothing to tell their items apart, and is deliberately the least preferred option.
 */
export const Locator = LocatorBase.extend({
  within: LocatorBase.extend({
    /** Text that picks this container out of its identical siblings. */
    hasText: z.string().trim().max(200).optional(),
  }).optional(),
  nth: z.number().int().min(0).max(500).optional(),
});
export type Locator = z.infer<typeof Locator>;

/** Where a step acts: a named element from the page library (preferred) or an inline locator. */
export const Target = z.union([z.object({ elementId: z.uuid() }), z.object({ locator: Locator })]);
export type Target = z.infer<typeof Target>;

// ---------- assertions ----------

export const ASSERTIONS = [
  'visible',
  'hidden',
  'enabled',
  'disabled',
  'checked',
  'text_equals',
  'text_contains',
  'value_equals',
  'count_equals',
  'url_contains',
  'title_contains',
  'status_equals',
] as const;
export type AssertionKind = (typeof ASSERTIONS)[number];

/** Page-level and API checks need no element; the rest check the step's target or their own. */
export const PAGE_ASSERTIONS: readonly AssertionKind[] = ['url_contains', 'title_contains'];
export const API_ASSERTIONS: readonly AssertionKind[] = ['status_equals'];

export const Assertion = z.object({
  kind: z.enum(ASSERTIONS),
  /** Expected text, value, count or status; may use {data.x}, {env.x}, {vars.x}. */
  expected: z.string().max(2000).optional(),
  /** Another element to check; defaults to the step's own target. */
  target: Target.optional(),
  /** Soft: record the failure and carry on. Hard (default): stop the test. */
  soft: z.boolean().default(false),
});
export type Assertion = z.infer<typeof Assertion>;

// ---------- steps ----------

export const STEP_ACTIONS = [
  'open',
  'click',
  'type',
  'select',
  'check',
  'uncheck',
  'hover',
  'press',
  'verify',
  'use_component',
  'api_request',
  'manual',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Actions that change what the page shows; they need an assertion unless marked "no check needed". */
export const CHANGING_ACTIONS: readonly StepAction[] = ['open', 'click', 'press', 'api_request'];

export const ApiRequest = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: z.string().trim().min(1).max(2000),
  headers: z.record(z.string(), z.string().max(4000)).default({}),
  body: z.string().max(100_000).optional(),
  /** Values saved for later steps as {vars.name}, read by a dot path into the JSON response. */
  extract: z.array(z.object({ name: z.string().regex(/^[a-zA-Z_]\w{0,40}$/), path: z.string().max(200) })).max(20).default([]),
});

export const AutoStep = z.object({
  id: z.string().min(1).max(40),
  action: z.enum(STEP_ACTIONS),
  target: Target.optional(),
  /** Text to type, option to select, key to press, or URL to open; may use {data.x} {secret.x} {env.x} {vars.x}. */
  value: z.string().max(4000).optional(),
  component: z.object({ id: z.uuid(), version: z.number().int().min(1), inputs: z.record(z.string(), z.string()) }).optional(),
  request: ApiRequest.optional(),
  assertions: z.array(Assertion).max(20).default([]),
  /** The tester's explicit "no check needed" for an action that would otherwise need an assertion. */
  noCheck: z.boolean().default(false),
  /** What the step is for, in plain words (testing-studio-plan §3.5). */
  intent: z.string().trim().max(300).default(''),
});
export type AutoStep = z.infer<typeof AutoStep>;

// ---------- tests ----------

export const TEST_KINDS = ['ui', 'api', 'journey'] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const SaveTestBody = z.object({
  title: z.string().trim().min(3).max(200),
  kind: z.enum(TEST_KINDS).default('ui'),
  caseId: z.uuid().nullable().default(null),
  dataSetId: z.uuid().nullable().default(null),
  /** Names of secrets the steps may use as {secret.name}; values live in the environment's secret store. */
  secrets: z.array(z.string().regex(/^[a-zA-Z_]\w{0,40}$/)).max(30).default([]),
  steps: z.array(AutoStep).min(1).max(200),
});
export type SaveTestBody = z.infer<typeof SaveTestBody>;

export type IssueSeverity = 'error' | 'warning';
/** One problem found when a test is saved: errors block saving, warnings are shown. */
export interface StepIssue {
  stepIndex: number | null;
  code: string;
  severity: IssueSeverity;
  message: string;
}

export interface StudioTest {
  id: string;
  key: string;
  title: string;
  kind: TestKind;
  status: 'draft' | 'ready' | 'quarantined' | 'archived';
  caseId: string | null;
  dataSetId: string | null;
  version: number;
  secrets: string[];
  steps: AutoStep[];
  warnings: StepIssue[];
  updatedAt: string;
}

// ---------- page library and components ----------

export const SaveElementBody = z.object({
  page: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  /** Ranked best first; the generator uses the first. */
  locators: z.array(Locator).min(1).max(5),
});

export interface PageElement {
  id: string;
  page: string;
  name: string;
  locators: Locator[];
  updatedAt: string;
}

export const SaveComponentBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).default(''),
  /** Inputs a tester fills in when using the component, referenced inside it as {data.name}. */
  inputs: z.array(z.string().regex(/^[a-zA-Z_]\w{0,40}$/)).max(20).default([]),
  steps: z.array(AutoStep).min(1).max(100),
  changelog: z.string().trim().max(500).default(''),
});

export interface StudioComponent {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  version: number;
  steps: AutoStep[];
  updatedAt: string;
}

/** Generated Playwright code for one test version, and whether it can run unattended. */
export interface GeneratedCode {
  code: string;
  /** False when a manual step means the test needs a person (Assist mode only). */
  runnable: boolean;
}

// ---------- automated runs ----------

export const StartAutoRunBody = z.object({
  name: z.string().trim().min(1).max(200),
  /** Step-built tests to run. */
  testIds: z.array(z.uuid()).max(500).default([]),
  /** Spec files from the code workspace to run, e.g. tests/checkout.spec.ts. */
  specPaths: z.array(z.string().max(300)).max(200).default([]),
  /** The environment under test; steps reach it as {env.baseUrl}. */
  baseUrl: z.url({ protocol: /^https?$/ }),
  /** Other {env.x} values for this run, e.g. a tenant id. */
  variables: z.record(z.string().regex(/^[a-zA-Z_]\w{0,40}$/), z.string().max(2000)).default({}),
  maxParallel: z.number().int().min(1).max(10).default(10),
  trigger: z.enum(['manual', 'ci', 'schedule']).default('manual'),
}).refine((b) => b.testIds.length + b.specPaths.length > 0, { message: 'Choose at least one test or spec file', path: ['testIds'] });

export type AutoItemStatus = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'error' | 'cancelled';

export interface AutoStepResult {
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error: string | null;
}

export interface AutoEvidence {
  kind: 'trace' | 'screenshot' | 'video';
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Short-lived download link. */
  url: string;
}

export interface AutoRunItem {
  id: string;
  /** Set for step-built tests; null for spec files. */
  testId: string | null;
  testKey: string | null;
  /** Set for spec files from the code workspace. */
  specPath: string | null;
  title: string;
  testVersion: number | null;
  dataRow: number | null;
  status: AutoItemStatus;
  attempt: number;
  flaky: boolean;
  error: string | null;
  durationMs: number | null;
  steps: AutoStepResult[];
  evidence: AutoEvidence[];
}

export interface AutoRun {
  id: string;
  key: string;
  name: string;
  status: 'queued' | 'running' | 'done' | 'cancelled';
  baseUrl: string;
  maxParallel: number;
  trigger: 'manual' | 'ci' | 'schedule';
  counts: Record<AutoItemStatus, number> & { total: number; flaky: number };
  createdAt: string;
  finishedAt: string | null;
}

export interface AutoRunDetail extends AutoRun {
  items: AutoRunItem[];
}

// ---------- code workspace ----------

/** Framework folders a workspace may use; anything else is refused, so paths can't escape it. */
// Each segment starts with a letter, digit, _ or -, so `.` and `..` can never appear as a segment.
export const CODE_PATH = /^(pages|fixtures|utils|tests|data)(\/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)+\.(ts|json)$/;
export const CODE_MAX_CHARS = 500_000;

export const SaveCodeFileBody = z.object({
  path: z.string().regex(CODE_PATH, 'Put files in pages/, fixtures/, utils/, tests/ or data/, ending in .ts or .json'),
  content: z.string().max(CODE_MAX_CHARS),
  /** The version the editor started from; a save over someone else's newer edit is refused. */
  baseVersion: z.number().int().min(0).optional(),
});

export interface CodeFileSummary {
  path: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface CodeFile extends CodeFileSummary {
  content: string;
}

/** A syntax problem found on save (line and column are 1-based). */
export interface CodeDiagnostic {
  line: number;
  column: number;
  message: string;
}

export interface SavedCodeFile {
  file: CodeFile;
  diagnostics: CodeDiagnostic[];
}

// ---------- locator picker ----------

/**
 * A short-lived pass carried by the picker running on the tester's own site. It can do one thing:
 * add elements to one project's page library, as that tester.
 */
export interface PickerClaims {
  kind: 'picker';
  project: string;
  org: string;
  user: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

export const CapturedElementsBody = z.object({
  ticket: z.string().min(10).max(2000),
  elements: z
    .array(z.object({ page: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120), locators: z.array(Locator).min(1).max(5) }))
    .min(1)
    .max(50),
});

export interface PickerSession {
  ticket: string;
  /** Ready-made `javascript:` bookmarklet that loads the picker on any page. */
  bookmarklet: string;
  /** The same loader as one line, for pasting into the browser console when a site's CSP blocks scripts. */
  consoleSnippet: string;
  expiresAt: string;
}

import { z } from 'zod';
import { ROLES, type Permission, type Role } from './access';
import {
  Automation,
  CaseFormat,
  CaseStatus,
  Priority,
  RecordableResult,
  Result,
  RunType,
  type Automation as AutomationT,
  type CaseFormat as CaseFormatT,
  type CaseStatus as CaseStatusT,
  type Priority as PriorityT,
  type Result as ResultT,
  type RunType as RunTypeT,
} from './domain';

// Request schemas are validated at the API boundary; response shapes are plain TypeScript types that the
// API returns and the web app consumes. Both sides import from here, so they cannot drift apart.

/** Query strings carry lists as "a,b,c". */
const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item));

const label = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.-]{0,39}$/,
    'Labels use lowercase letters, digits, dots and hyphens (up to 40 characters), such as release-4.18',
  );

/** Which cases an operation applies to. Shared by the list query, bulk edits and run creation. */
export const CaseFilter = z.object({
  moduleId: z.uuid().optional(),
  priority: z.array(Priority).max(4).optional(),
  status: z.array(CaseStatus).max(5).optional(),
  labels: z.array(label).max(10).optional(),
  ownerId: z.uuid().optional(),
  lastResult: z.array(Result).max(5).optional(),
  q: z.string().trim().max(200).optional(),
  /** Explicit selection, e.g. rows ticked in the grid. Combined with the other fields using AND. */
  keys: z
    .array(z.string().regex(/^TC-\d+$/i))
    .max(5000)
    .optional(),
});
export type CaseFilter = z.infer<typeof CaseFilter>;

export const CASE_SORTS = ['key', 'title', 'priority', 'updated', 'status', 'module', 'lastResult'] as const;
export type CaseSort = (typeof CASE_SORTS)[number];

export const CaseListQuery = z.object({
  moduleId: z.uuid().optional(),
  priority: csv(Priority).optional(),
  status: csv(CaseStatus).optional(),
  labels: csv(label).optional(),
  ownerId: z.uuid().optional(),
  lastResult: csv(Result).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(CASE_SORTS).default('key'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type CaseListQuery = z.infer<typeof CaseListQuery>;

export const CaseGroupQuery = CaseListQuery.pick({
  moduleId: true,
  priority: true,
  status: true,
  labels: true,
  ownerId: true,
  lastResult: true,
  q: true,
}).extend({ by: z.enum(['priority', 'status', 'module', 'lastResult']) });
export type CaseGroupQuery = z.infer<typeof CaseGroupQuery>;

export const StepInput = z.object({
  action: z.string().trim().min(1).max(2000),
  expected: z.string().trim().max(2000).default(''),
  data: z.string().trim().max(1000).default(''),
});
export type StepInput = z.infer<typeof StepInput>;

const caseContent = {
  title: z.string().trim().min(3).max(300),
  preconditions: z.string().max(5000),
  format: CaseFormat,
  steps: z.array(StepInput).max(100),
  gherkin: z.string().max(20000).nullable(),
};
const caseMetadata = {
  moduleId: z.uuid(),
  priority: Priority,
  type: z.string().trim().min(1).max(40),
  status: CaseStatus,
  ownerId: z.uuid().nullable(),
  labels: z.array(label).max(20),
  estimateMin: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .nullable(),
  automation: Automation,
  custom: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
};

export const CreateCaseBody = z.object({
  ...caseContent,
  ...caseMetadata,
  preconditions: caseContent.preconditions.default(''),
  format: caseContent.format.default('steps'),
  steps: caseContent.steps.default([]),
  gherkin: caseContent.gherkin.default(null),
  priority: Priority.default('P2'),
  type: caseMetadata.type.default('Functional'),
  status: CaseStatus.default('draft'),
  ownerId: caseMetadata.ownerId.default(null),
  labels: caseMetadata.labels.default([]),
  estimateMin: caseMetadata.estimateMin.default(null),
  automation: Automation.default('manual'),
  custom: caseMetadata.custom.default({}),
});
export type CreateCaseBody = z.infer<typeof CreateCaseBody>;

/** Any content field present creates a new immutable version; metadata-only edits do not. */
export const UpdateCaseBody = z
  .object({
    ...caseContent,
    ...caseMetadata,
    note: z.string().max(500).optional(),
    /** The version the editor started from. A content edit against an older version is refused (409). */
    baseVersion: z.number().int().min(1).optional(),
  })
  .partial()
  .refine((b) => Object.keys(b).some((k) => k !== 'note' && k !== 'baseVersion'), 'Nothing to update');
export type UpdateCaseBody = z.infer<typeof UpdateCaseBody>;
export const CASE_CONTENT_FIELDS = Object.keys(caseContent) as (keyof typeof caseContent)[];

export const SetDependenciesBody = z.object({ dependsOn: z.array(z.string().regex(/^TC-\d+$/i)).max(50) });

export const BulkPatch = z
  .object({
    status: CaseStatus,
    priority: Priority,
    ownerId: z.uuid().nullable(),
    addLabels: z.array(label).min(1).max(10),
    removeLabels: z.array(label).min(1).max(10),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Choose at least one change');
export type BulkPatch = z.infer<typeof BulkPatch>;
export const BulkEditBody = z.object({ filter: CaseFilter, patch: BulkPatch });

export const CreateRunBody = z.object({
  name: z.string().trim().min(3).max(200),
  type: RunType.default('custom'),
  environment: z.string().trim().min(1).max(60),
  build: z.string().trim().min(1).max(60),
  configs: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  assigneeIds: z.array(z.uuid()).max(50).default([]),
  filter: CaseFilter,
  dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type CreateRunBody = z.infer<typeof CreateRunBody>;

export const RecordResultBody = z
  .object({
    stepIndex: z.number().int().min(0).max(99),
    status: RecordableResult,
    actual: z.string().trim().max(5000).optional(),
    /** Seconds the tester spent on the case since the last recorded result (execute-view timer). */
    elapsedS: z
      .number()
      .int()
      .min(0)
      .max(24 * 3600)
      .default(0),
  })
  .refine((b) => !(b.status === 'failed' || b.status === 'blocked') || !!b.actual, {
    message: 'Describe what actually happened when a step fails or is blocked',
    path: ['actual'],
  });
export type RecordResultBody = z.infer<typeof RecordResultBody>;

export const EVIDENCE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'text/plain',
  'application/json',
] as const;
export const EVIDENCE_MAX_BYTES = 100 * 1024 * 1024;
export const EvidenceUploadBody = z.object({
  stepIndex: z.number().int().min(0).max(99),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(EVIDENCE_TYPES),
  sizeBytes: z.number().int().min(1).max(EVIDENCE_MAX_BYTES),
});

export const UpdateMemberBody = z.object({ role: z.enum(ROLES) });

// ---------- responses ----------

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface UserRef {
  id: string;
  name: string;
  email: string;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  /** Product line or team the project belongs to, e.g. "Payments"; null when ungrouped. */
  group: string | null;
  archived: boolean;
  permissions: Permission[];
}

export interface Me {
  user: UserRef;
  org: { id: string; slug: string; name: string };
  projects: ProjectSummary[];
  /** From organisation-wide roles only: what the admin console and "New project" check. */
  orgPermissions: Permission[];
}

const projectGroup = z.string().trim().min(1).max(60);

export const ProjectBody = z.object({
  key: z
    .string()
    .trim()
    .transform((k) => k.toUpperCase())
    .pipe(
      z
        .string()
        .regex(
          /^[A-Z][A-Z0-9]{1,9}$/,
          'Keys are 2-10 letters or digits, starting with a letter, such as KYC',
        ),
    ),
  name: z.string().trim().min(1).max(120),
  group: projectGroup.nullable().default(null),
  description: z.string().trim().max(500).default(''),
  /** Copy this project's module tree (not its cases), so a new product starts with the same structure. */
  copyModulesFrom: z.uuid().optional(),
});

export const ProjectPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  group: projectGroup.nullable().optional(),
  description: z.string().trim().max(500).optional(),
  archived: z.boolean().optional(),
});

export interface ProjectOverview {
  id: string;
  key: string;
  name: string;
  group: string | null;
  description: string;
  archived: boolean;
  cases: number;
  failing: number;
  activeRuns: number;
  /** Share of results passed in the last 30 days; null with no results. */
  passRate: number | null;
  openDefects: number;
  lastActivity: string | null;
  /** People with a role on this project specifically (org-wide roles cover every project). */
  members: number;
}

export interface Member {
  user: UserRef;
  role: Role;
  scope: 'org' | 'project';
}

export interface ModuleNode {
  id: string;
  parentId: string | null;
  name: string;
  /** Order among siblings, as arranged by the team. */
  position: number;
  total: number;
  failing: number;
}

export interface CaseRow {
  id: string;
  key: string;
  title: string;
  moduleId: string;
  modulePath: string;
  priority: PriorityT;
  type: string;
  status: CaseStatusT;
  lastResult: ResultT;
  labels: string[];
  owner: UserRef | null;
  estimateMin: number | null;
  automation: AutomationT;
  updatedAt: string;
}

export interface CaseCount {
  /** Exact up to `capped`; above it the UI shows "10,000+". Counting millions of rows per keystroke is not worth it. */
  count: number;
  capped: boolean;
}

export interface CaseGroup {
  value: string;
  label: string;
  count: number;
}

export interface Step {
  action: string;
  expected: string;
  data: string;
}

export interface CaseVersion {
  version: number;
  title: string;
  preconditions: string;
  format: CaseFormatT;
  steps: Step[];
  gherkin: string | null;
  note: string;
  author: UserRef | null;
  createdAt: string;
}

export interface CaseResultRef {
  runKey: string;
  runName: string;
  build: string;
  config: string;
  status: ResultT;
  at: string;
}

export interface CaseDetail extends CaseRow {
  preconditions: string;
  custom: Record<string, unknown>;
  currentVersion: number;
  version: CaseVersion;
  dependsOn: { key: string; title: string; lastResult: ResultT }[];
  usedBy: { key: string; title: string }[];
  recentResults: CaseResultRef[];
  createdAt: string;
  /** Set when the case runs once per row of a data set. */
  dataSet: { id: string; name: string; rowCount: number } | null;
}

export interface JobStatus {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number;
  processed: number;
  error: string | null;
}

export interface RunCounts {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
}

export interface RunSummary {
  id: string;
  key: string;
  name: string;
  type: RunTypeT;
  environment: string;
  build: string;
  configs: string[];
  status: 'preparing' | 'active' | 'completed';
  dueAt: string | null;
  counts: RunCounts;
  assignees: UserRef[];
  createdAt: string;
}

export interface RunItemRow {
  id: string;
  caseKey: string;
  title: string;
  priority: PriorityT;
  modulePath: string;
  config: string;
  status: ResultT;
  assignee: UserRef | null;
  blockedReason: string | null;
  position: number;
  /** For data-driven cases: which row of the data set this item runs (0-based), and its values. */
  dataRow: number | null;
  data: Record<string, string> | null;
}

export interface Evidence {
  id: string;
  stepIndex: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface RunItemDetail extends RunItemRow {
  runId: string;
  caseId: string;
  caseVersion: number;
  preconditions: string;
  steps: Step[];
  stepStatus: ResultT[];
  /** Latest recorded "actual result" per step, when one was given. */
  actuals: (string | null)[];
  evidence: Evidence[];
  previous: CaseResultRef[];
  durationS: number;
  needsReview: boolean;
}

export interface RecordResultResponse {
  item: RunItemDetail;
  counts: RunCounts;
  /** Other items in the run whose status changed as a consequence (dependency auto-block). */
  affected: { id: string; status: ResultT; blockedReason: string | null }[];
}

export interface EvidenceUpload {
  evidence: Evidence;
  uploadUrl: string;
}

export interface QueueItem extends RunItemRow {
  runId: string;
  runKey: string;
  runName: string;
  estimateMin: number | null;
}

export interface HomeSummary {
  assigned: number;
  assignedMinutes: number;
  executedToday: number;
  passedToday: number;
  queue: QueueItem[];
  activeRuns: RunSummary[];
}

// ---------- M2: search ----------

export const SearchBody = z.object({
  tql: z.string().max(4000),
  cursor: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** Every matching key (up to the run limit), for "Create run from results". */
export const SearchKeysBody = z.object({ tql: z.string().max(4000) });

export interface SearchHit extends CaseRow {
  /** Matched text wrapped in <mark>; the web app renders only these tags. */
  highlight: { title?: string; steps?: string };
}

export interface SearchResult {
  total: number;
  /** True when there are more matches than `total` counts exactly (100,000+). */
  totalCapped: boolean;
  tookMs: number;
  items: SearchHit[];
  groups: CaseGroup[] | null;
  nextCursor: string | null;
}

export interface TqlProblem {
  message: string;
  start: number;
  end: number;
}

export const SavedFilterBody = z.object({
  name: z.string().trim().min(1).max(120),
  tql: z.string().max(4000),
  shared: z.boolean().default(false),
});

export interface SavedFilter {
  id: string;
  name: string;
  tql: string;
  shared: boolean;
  owner: UserRef;
  mine: boolean;
  subscribed: boolean;
}

// ---------- M2: defects ----------

export const SEVERITIES = ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LogBugBody = z.object({
  runId: z.uuid(),
  itemId: z.uuid(),
  summary: z.string().trim().min(5).max(250),
  severity: z.enum(SEVERITIES).default('Major'),
  labels: z.array(label).max(10).default([]),
});

export const LinkBugBody = z.object({
  runId: z.uuid(),
  itemId: z.uuid(),
  jiraKey: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/i, 'Use a Jira key such as PAY-4938'),
});

export const RetestBody = z
  .object({
    status: z.enum(['passed', 'failed']),
    build: z.string().trim().min(1).max(60),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((b) => b.status === 'passed' || !!b.note, {
    message: 'Say what still fails, so the developer can see it in Jira',
    path: ['note'],
  });

export const DefectListQuery = z.object({
  view: z.enum(['all', 'retest', 'mine']).default('all'),
  status: z.enum(['open', 'done', 'any']).default('any'),
  caseId: z.uuid().optional(),
  /** An exact Jira status name, e.g. "In QA"; narrower than `status`, which is the category. */
  jiraStatus: z.string().trim().max(60).optional(),
  /** Bugs by default: the tracker is about defects, while stories and tasks are linked from cases. */
  type: z.enum(['bugs', 'all']).default('bugs'),
});

export interface DefectRow {
  id: string;
  jiraKey: string;
  /** Bug, Story, Task, Epic… as Jira names it. */
  issueType: string;
  jiraUrl: string;
  summary: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  severity: Severity;
  assignee: string | null;
  fixVersion: string | null;
  createdAt: string;
  syncedAt: string;
  reporter: UserRef;
  linkedCases: { key: string; title: string }[];
  /** 'pending' while any linked case still waits for a retest. */
  retest: 'pending' | 'passed' | 'failed' | null;
}

export interface DefectEvent {
  kind: string;
  detail: string;
  actor: UserRef | null;
  at: string;
}

export interface RetestItem {
  id: string;
  caseKey: string;
  caseTitle: string;
  status: 'pending' | 'passed' | 'failed';
  assignee: UserRef | null;
  build: string | null;
  note: string | null;
  requestedAt: string;
}

export interface DefectDetail extends DefectRow {
  timeline: DefectEvent[];
  retests: RetestItem[];
  items: { runKey: string; runName: string; build: string; config: string; caseKey: string }[];
}

export interface SimilarDefect {
  jiraKey: string;
  summary: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  /** 0–100, text similarity to the new bug's summary. */
  similarity: number;
  /** Already linked to a case in this project. */
  known: boolean;
}

export interface SyncStatus {
  connected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

// ---------- Jira issues linked to cases ----------

export const LinkIssueBody = z.object({
  jiraKey: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9]*-\d+$/i, 'Use a Jira key such as PAY-4821'),
});

export interface CaseJiraLink {
  id: string;
  jiraKey: string;
  jiraUrl: string;
  issueType: string;
  summary: string;
  /** The status exactly as named in the Jira workflow ("In QA", "Won't Do"). */
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  assignee: string | null;
  fixVersion: string | null;
  /** "case" when linked to the case directly, "run" when logged or linked from a failed run item. */
  via: ('case' | 'run')[];
  syncedAt: string;
}

export interface JiraStatus {
  name: string;
  category: 'new' | 'indeterminate' | 'done';
}

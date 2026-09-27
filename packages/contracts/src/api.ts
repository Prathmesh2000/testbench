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
  permissions: Permission[];
}

export interface Me {
  user: UserRef;
  org: { id: string; slug: string; name: string };
  projects: ProjectSummary[];
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

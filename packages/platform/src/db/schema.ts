import type { ColumnType, Generated } from 'kysely';

// Kysely table types for db/migrations. Keep in step with the SQL: a column added there needs adding here.
// Timestamps are read back as Date (pg's default) and accepted as Date or ISO string on write.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;

export interface OrgTable {
  id: Generated<string>;
  slug: string;
  name: string;
  created_at: Timestamp;
}

export interface AppUserTable {
  id: Generated<string>;
  subject: string | null;
  email: string;
  name: string;
  created_at: Timestamp;
}

export interface MembershipTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  project_id: string | null;
  role: string;
  created_at: Timestamp;
}

export interface ProjectTable {
  id: Generated<string>;
  org_id: string;
  key: string;
  name: string;
  next_case_no: Generated<number>;
  next_run_no: Generated<number>;
  created_at: Timestamp;
}

export interface ModuleTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  path: string;
  position: Generated<number>;
}

export interface TestCaseTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  key_no: number;
  module_id: string;
  title: string;
  priority: Generated<string>;
  type: Generated<string>;
  status: Generated<string>;
  owner_id: string | null;
  labels: Generated<string[]>;
  custom: ColumnType<Record<string, unknown>, string | undefined, string>;
  estimate_min: number | null;
  automation: Generated<string>;
  last_result: Generated<string>;
  last_run_at: NullableTimestamp;
  current_version: Generated<number>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface StepJson {
  action: string;
  expected: string;
  data: string;
}

export interface CaseVersionTable {
  project_id: string;
  case_id: string;
  version: number;
  org_id: string;
  title: string;
  preconditions: Generated<string>;
  format: Generated<string>;
  steps: Json<StepJson[]>;
  gherkin: string | null;
  note: Generated<string>;
  author_id: string | null;
  created_at: Timestamp;
}

export interface CaseDependencyTable {
  org_id: string;
  project_id: string;
  case_id: string;
  depends_on_id: string;
}

export interface ModuleStatsTable {
  module_id: string;
  org_id: string;
  project_id: string;
  total: number;
  failing: number;
}

export interface BulkJobTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  filter: ColumnType<unknown, string, string>;
  patch: ColumnType<unknown, string, string>;
  status: Generated<string>;
  total: Generated<number>;
  processed: Generated<number>;
  cursor: string | null;
  error: string | null;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}

export interface RunTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  key_no: number;
  name: string;
  type: Generated<string>;
  environment: string;
  build: string;
  configs: string[];
  status: Generated<string>;
  due_at: NullableTimestamp;
  total: Generated<number>;
  passed: Generated<number>;
  failed: Generated<number>;
  blocked: Generated<number>;
  skipped: Generated<number>;
  created_by: string;
  created_at: Timestamp;
}

export interface RunItemTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  run_id: string;
  case_id: string;
  case_version: number;
  config: string;
  position: number;
  assignee_id: string | null;
  status: Generated<string>;
  step_status: ColumnType<string[], string | undefined, string>;
  blocked_by: string | null;
  blocked_reason: string | null;
  duration_s: Generated<number>;
  updated_at: Timestamp;
}

export interface StepResultTable {
  id: Generated<string>;
  org_id: string;
  run_item_id: string;
  step_index: number;
  status: string;
  actual: string | null;
  recorded_by: string;
  recorded_at: Timestamp;
}

export interface EvidenceTable {
  id: Generated<string>;
  org_id: string;
  run_item_id: string;
  step_index: number;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_by: string;
  created_at: Timestamp;
}

export interface OutboxEventTable {
  id: string;
  org_id: string;
  project_id: string | null;
  type: string;
  actor: string | null;
  occurred_at: Timestamp;
  version: number;
  data: ColumnType<unknown, string, string>;
  published_at: NullableTimestamp;
  claimed_until: NullableTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
  dead_at: NullableTimestamp;
}

export interface ProcessedEventTable {
  consumer: string;
  event_id: string;
  org_id: string;
  processed_at: Timestamp;
}

export interface SavedFilterTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  name: string;
  tql: string;
  owner_id: string;
  shared: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FilterSubscriptionTable {
  filter_id: string;
  user_id: string;
  org_id: string;
  created_at: Timestamp;
}

export interface DefectTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  jira_key: string;
  jira_id: string | null;
  summary: string;
  status: string;
  status_category: string;
  severity: Generated<string>;
  assignee_name: string | null;
  fix_version: string | null;
  jira_updated_at: NullableTimestamp;
  synced_at: Timestamp;
  created_by: string;
  created_at: Timestamp;
}

export interface DefectItemLinkTable {
  defect_id: string;
  run_item_id: string;
  org_id: string;
  case_id: string;
  linked_by: string;
  linked_at: Timestamp;
}

export interface RetestTable {
  id: Generated<string>;
  org_id: string;
  defect_id: string;
  case_id: string;
  assignee_id: string | null;
  status: Generated<string>;
  build: string | null;
  note: string | null;
  requested_at: Timestamp;
  done_by: string | null;
  done_at: NullableTimestamp;
}

export interface DefectEventTable {
  id: Generated<string>;
  org_id: string;
  defect_id: string;
  kind: string;
  detail: string;
  actor: string | null;
  created_at: Timestamp;
}

export interface SyncStateTable {
  project_id: string;
  org_id: string;
  last_run_at: Timestamp;
  last_error: string | null;
}

export interface RunPrepTable {
  run_id: string;
  org_id: string;
  project_id: string;
  filter: ColumnType<unknown, string, string>;
  assignees: Generated<string[]>;
  cursor_path: string | null;
  cursor_key: number | null;
  cases_done: Generated<number>;
  status: Generated<string>;
  error: string | null;
  created_by: string;
  updated_at: Timestamp;
}

export interface Database {
  'iam.org': OrgTable;
  'iam.app_user': AppUserTable;
  'iam.membership': MembershipTable;
  'repo.project': ProjectTable;
  'repo.module': ModuleTable;
  'repo.test_case': TestCaseTable;
  'repo.case_version': CaseVersionTable;
  'repo.case_dependency': CaseDependencyTable;
  'repo.module_stats': ModuleStatsTable;
  'repo.bulk_job': BulkJobTable;
  'exec.run': RunTable;
  'exec.run_item': RunItemTable;
  'exec.step_result': StepResultTable;
  'exec.evidence': EvidenceTable;
  'outbox.event': OutboxEventTable;
  'outbox.processed': ProcessedEventTable;
  'search.saved_filter': SavedFilterTable;
  'search.filter_subscription': FilterSubscriptionTable;
  'defect.defect': DefectTable;
  'defect.item_link': DefectItemLinkTable;
  'defect.retest': RetestTable;
  'defect.event': DefectEventTable;
  'defect.sync_state': SyncStateTable;
  'exec.run_prep': RunPrepTable;
}

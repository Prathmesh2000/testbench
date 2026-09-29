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
  group_name: string | null;
  description: Generated<string>;
  archived: Generated<boolean>;
  created_by: string | null;
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
  data_set_id: string | null;
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
  data_row: number | null;
  data: ColumnType<Record<string, string> | null, string | null | undefined, string | null>;
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
  source: Generated<string>;
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
  issue_type: Generated<string>;
  site_url: string | null;
  synced_at: Timestamp;
  created_by: string;
  created_at: Timestamp;
}

export interface JiraConnectionTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  auth_type: Generated<string>;
  site_url: string;
  email: string;
  account_id: string;
  display_name: string;
  secret_enc: string;
  status: Generated<string>;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface JiraProjectMapTable {
  project_id: string;
  org_id: string;
  site_url: string;
  jira_key: string;
  issue_type: Generated<string>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface DefectAttachmentTable {
  id: Generated<string>;
  org_id: string;
  defect_id: string;
  evidence_id: string;
  uploader_id: string;
  status: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  jira_attachment_id: string | null;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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

export interface RequirementJson {
  ref: string;
  title: string;
  text: string;
}

export interface DocumentTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  title: string;
  current_version: Generated<number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DocumentVersionTable {
  document_id: string;
  version: number;
  org_id: string;
  body: string;
  requirements: Json<RequirementJson[]>;
  extracted_by: string;
  created_by: string;
  created_at: Timestamp;
}

export interface RequirementTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  document_id: string;
  ref: string;
  title: string;
  text: string;
  position: number;
  change: Generated<string>;
  changed_in: number;
}

export interface RequirementCaseTable {
  requirement_id: string;
  case_id: string;
  org_id: string;
  project_id: string;
  linked_by: string;
  linked_at: Timestamp;
}

export interface CaseFlagTable {
  case_id: string;
  requirement_id: string;
  org_id: string;
  project_id: string;
  kind: string;
  reason: string;
  flagged_at: Timestamp;
}

export interface SignoffTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  build: string;
  decision: string;
  note: Generated<string>;
  criteria: ColumnType<unknown, string, string>;
  decided_by: string;
  decided_at: Timestamp;
}

export interface AiConfigTable {
  org_id: string;
  policy: Generated<string>;
  allowed: Generated<string[]>;
  tasks: ColumnType<Record<string, unknown>, string | undefined, string>;
  monthly_budget: ColumnType<number, number | undefined, number>;
  keys: ColumnType<Record<string, { ciphertext: string; hint: string }>, string | undefined, string>;
  updated_by: string | null;
  updated_at: Timestamp;
}

export interface AiUsageTable {
  id: Generated<string>;
  org_id: string;
  user_id: string | null;
  task: string;
  provider: string;
  model: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  ok: boolean;
  error: string | null;
  created_at: Timestamp;
}

export interface CustomRoleTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  based_on: string;
  permissions: string[];
  version: Generated<number>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface TokenTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string[];
  expires_at: Timestamp;
  last_used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AuditEntryTable {
  id: string;
  org_id: string;
  project_id: string | null;
  at: Timestamp;
  actor_id: string | null;
  source: string;
  action: string;
  entity: string;
  details: string;
  data: ColumnType<unknown, string, string>;
}

export interface BoardTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  kind: string;
  title: string;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived: Generated<boolean>;
}

export interface BoardStateTable {
  board_id: string;
  org_id: string;
  state: Buffer;
  updated_at: Timestamp;
}

export interface MeetingTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  title: string;
  starts_at: Timestamp;
  minutes: number;
  attendees: Generated<string[]>;
  context: string | null;
  notes_board: string;
  calendar: Generated<string>;
  calendar_id: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface ActionItemTable {
  id: Generated<string>;
  org_id: string;
  meeting_id: string;
  text: string;
  assignee_id: string | null;
  status: Generated<string>;
  converted_to: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface DataSetTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  name: string;
  description: Generated<string>;
  columns: string[];
  rows: ColumnType<Record<string, string>[], string | undefined, string>;
  version: Generated<number>;
  updated_by: string;
  updated_at: Timestamp;
  created_at: Timestamp;
}

export interface DataFileTable {
  id: Generated<string>;
  org_id: string;
  data_set_id: string;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: Timestamp;
}

export interface CaseLinkTable {
  defect_id: string;
  case_id: string;
  org_id: string;
  project_id: string;
  linked_by: string;
  linked_at: Timestamp;
}

export interface LiveSessionTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  user_id: string;
  url: string;
  device: string;
  run_item_id: string | null;
  started_at: Timestamp;
  ended_at: NullableTimestamp;
  expires_at: Timestamp;
}

export interface StudioTestTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  key_no: number;
  title: string;
  kind: Generated<string>;
  status: Generated<string>;
  case_id: string | null;
  data_set_id: string | null;
  current_version: Generated<number>;
  owner_id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface StudioTestVersionTable {
  test_id: string;
  version: number;
  org_id: string;
  steps: Json<unknown[]>;
  secrets: string[];
  warnings: Json<unknown[]>;
  created_by: string;
  created_at: Timestamp;
}

export interface PageElementTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  page: string;
  name: string;
  locators: Json<unknown[]>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface StudioComponentTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  name: string;
  description: Generated<string>;
  inputs: string[];
  current_version: Generated<number>;
  updated_at: Timestamp;
}

export interface StudioComponentVersionTable {
  component_id: string;
  version: number;
  org_id: string;
  steps: Json<unknown[]>;
  inputs: string[];
  changelog: Generated<string>;
  created_by: string;
  created_at: Timestamp;
}

export interface AutoRunTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  key_no: number;
  name: string;
  base_url: string;
  variables: Json<Record<string, string>>;
  max_parallel: Generated<number>;
  trigger: Generated<string>;
  status: Generated<string>;
  created_by: string;
  created_at: Timestamp;
  finished_at: NullableTimestamp;
  workspace: Json<Record<string, string> | null> | null;
}

export interface AutoRunItemTable {
  id: Generated<string>;
  org_id: string;
  run_id: string;
  test_id: string | null;
  test_version: number | null;
  spec_path: string | null;
  data_row: number | null;
  data: Json<Record<string, string>>;
  code: string;
  status: Generated<string>;
  attempt: Generated<number>;
  flaky: Generated<boolean>;
  error: string | null;
  steps: Json<unknown[]>;
  evidence: Json<unknown[]>;
  duration_ms: number | null;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface CodeFileTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  path: string;
  content: string;
  version: Generated<number>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface CodeFileVersionTable {
  file_id: string;
  version: number;
  org_id: string;
  content: string;
  created_by: string;
  created_at: Timestamp;
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
  'docs.document': DocumentTable;
  'docs.document_version': DocumentVersionTable;
  'docs.requirement': RequirementTable;
  'docs.requirement_case': RequirementCaseTable;
  'docs.case_flag': CaseFlagTable;
  'analytics.signoff': SignoffTable;
  'ai.config': AiConfigTable;
  'ai.usage': AiUsageTable;
  'iam.custom_role': CustomRoleTable;
  'iam.token': TokenTable;
  'audit.entry': AuditEntryTable;
  'collab.board': BoardTable;
  'collab.board_state': BoardStateTable;
  'meet.meeting': MeetingTable;
  'meet.action_item': ActionItemTable;
  'repo.data_set': DataSetTable;
  'repo.data_file': DataFileTable;
  'defect.case_link': CaseLinkTable;
  'defect.jira_connection': JiraConnectionTable;
  'defect.jira_project_map': JiraProjectMapTable;
  'defect.attachment': DefectAttachmentTable;
  'studio.live_session': LiveSessionTable;
  'studio.test': StudioTestTable;
  'studio.test_version': StudioTestVersionTable;
  'studio.page_element': PageElementTable;
  'studio.component': StudioComponentTable;
  'studio.component_version': StudioComponentVersionTable;
  'studio.auto_run': AutoRunTable;
  'studio.auto_run_item': AutoRunItemTable;
  'studio.code_file': CodeFileTable;
  'studio.code_file_version': CodeFileVersionTable;
}

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
  /** TestIntent; null when the test was not built from an intent. */
  intent: Json<Record<string, unknown>> | null;
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
  /** ComponentMeta. Written as a JSON string; optional on insert because the column defaults to {}. */
  meta: ColumnType<Record<string, unknown>, string | undefined, string>;
  updated_at: Timestamp;
}

/** A page the Test Browser reached (SitePage, less its id and times). */
export interface SitePageTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  path: string;
  body: ColumnType<Record<string, unknown>, string, string>;
  visits: Generated<number>;
  first_seen: Timestamp;
  last_seen: Timestamp;
}

/** WorkflowPlan, one per workflow component. */
export interface WorkflowPlanTable {
  component_id: string;
  org_id: string;
  project_id: string;
  body: ColumnType<Record<string, unknown>, string, string>;
  updated_by: string;
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

/** jsonb with a database default: written as a JSON string, optional on insert. */
type JsonDefault<T> = ColumnType<T, string | undefined, string>;

export interface ApiWorkspaceTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  name: string;
  kind: Generated<string>;
  owner_id: string;
  /** StoredVariable[]: secret values are ciphertext. */
  variables: JsonDefault<unknown[]>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApiNodeTable {
  id: Generated<string>;
  org_id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  position: Generated<number>;
  /** Collections and folders: { auth, variables }. Requests: ApiRequestDef. */
  config: JsonDefault<Record<string, unknown>>;
  updated_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApiVariationTable {
  id: Generated<string>;
  org_id: string;
  request_id: string;
  name: string;
  position: Generated<number>;
  overrides: JsonDefault<Record<string, unknown>>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ApiEnvironmentTable {
  id: Generated<string>;
  org_id: string;
  workspace_id: string;
  name: string;
  position: Generated<number>;
  variables: JsonDefault<unknown[]>;
  production: Generated<boolean>;
  updated_at: Timestamp;
}

export interface ApiCookieJarTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  workspace_id: string;
  environment_id: string | null;
  cookies_enc: string;
  updated_at: Timestamp;
}

export interface ApiSpecTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  name: string;
  source_url: string | null;
  current_version: Generated<number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ApiSpecVersionTable {
  spec_id: string;
  version: number;
  org_id: string;
  format: string;
  title: string;
  api_version: string;
  hash: string;
  storage_key: string;
  size_bytes: number;
  operations: Json<unknown[]>;
  servers: ColumnType<string[], string[] | undefined, string[]>;
  /** SpecDiff against the previous version; null for version 1. */
  diff: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  created_by: string;
  created_at: Timestamp;
}

export interface ApiHistoryTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  workspace_id: string;
  user_id: string;
  node_id: string | null;
  method: string;
  url: string;
  status: number | null;
  duration_ms: number;
  request: Json<Record<string, unknown>>;
  response: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  error: string | null;
  created_at: Timestamp;
}

export interface ApiClientCertTable {
  id: Generated<string>;
  org_id: string;
  workspace_id: string;
  name: string;
  host: string;
  /** Encrypted JSON: { cert, key, passphrase, ca }. */
  bundle_enc: string;
  subject: string;
  expires_at: NullableTimestamp;
  created_by: string;
  updated_at: Timestamp;
}

export interface ApiAuthProfileTable {
  id: Generated<string>;
  org_id: string;
  workspace_id: string;
  name: string;
  login_node_id: string | null;
  /** AuthProfileConfig. */
  config: Json<Record<string, unknown>>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ApiDependencyLinkTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  from_key: string;
  to_key: string;
  param_in: string;
  param_name: string;
  field: string | null;
  status: string;
  decided_by: string;
  decided_at: Timestamp;
}

export interface ApiWorkflowTable {
  id: Generated<string>;
  org_id: string;
  workspace_id: string;
  name: string;
  description: Generated<string>;
  current_version: Generated<number>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ApiWorkflowVersionTable {
  workflow_id: string;
  version: number;
  org_id: string;
  /** ApiWorkflowDef. */
  def: Json<Record<string, unknown>>;
  created_by: string;
  created_at: Timestamp;
}

export interface ApiWorkflowRunTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  workflow_id: string;
  version: number;
  user_id: string;
  environment_id: string | null;
  mode: string;
  status: string;
  next_step: Generated<number>;
  results: JsonDefault<unknown[]>;
  state_enc: string | null;
  error: string | null;
  started_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}

export interface ApiLintSettingTable {
  org_id: string;
  project_id: string;
  rule: string;
  enabled: boolean;
  reason: Generated<string>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ApiEnrichmentAnswerTable {
  id: Generated<string>;
  org_id: string;
  spec_id: string;
  question_id: string;
  kind: string;
  status: string;
  answer: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  patches: JsonDefault<unknown[]>;
  source: string | null;
  assigned_to: string | null;
  answered_by: string | null;
  answered_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface ApiGeneratedTestTable {
  id: Generated<string>;
  org_id: string;
  spec_id: string;
  gen_id: string;
  version: number;
  operation: string;
  kind: string;
  name: string;
  payload: Json<Record<string, unknown>>;
  status: Generated<string>;
  request_id: string | null;
  variation_id: string | null;
  decided_by: string | null;
  updated_at: Timestamp;
}

export interface ApiSuiteTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  items: Json<unknown[]>;
  settings: Json<Record<string, unknown>>;
  schedule: Json<Record<string, unknown>>;
  next_run_at: NullableTimestamp;
  owner_id: string;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ApiSuiteRunTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  suite_id: string;
  trigger: string;
  status: string;
  environment_id: string | null;
  totals: JsonDefault<Record<string, unknown>>;
  error: string | null;
  triggered_by: string | null;
  started_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}

export interface ApiSuiteResultTable {
  id: Generated<string>;
  org_id: string;
  run_id: string;
  position: number;
  key: string;
  group_name: string;
  name: string;
  row_index: number | null;
  status: string;
  flaky: Generated<boolean>;
  attempts: Generated<number>;
  http_status: number | null;
  duration_ms: number;
  message: Generated<string>;
  history_id: string | null;
  drift_issues: Generated<number>;
  method: string | null;
  operation: string | null;
  created_at: Timestamp;
}

export interface ApiMockTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  spec_id: string;
  token_hash: string;
  token_enc: string;
  enabled: Generated<boolean>;
  config: JsonDefault<Record<string, unknown>>;
  overrides: JsonDefault<Record<string, unknown>>;
  owner_id: string;
  updated_at: Timestamp;
}

export interface ApiTargetTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  host: string;
  token: string;
  status: Generated<string>;
  method: string | null;
  verified_at: NullableTimestamp;
  verified_by: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface ApiFindingTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  spec_id: string;
  fingerprint: string;
  rule: string;
  severity: string;
  owasp: string;
  operation: string | null;
  title: string;
  detail: string;
  evidence: Json<Record<string, unknown>>;
  history_id: string | null;
  status: Generated<string>;
  suppress_reason: string | null;
  suppress_until: NullableTimestamp;
  suppressed_by: string | null;
  first_seen: Timestamp;
  last_seen: Timestamp;
}

export interface ApiSecurityRunTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  spec_id: string;
  user_id: string;
  environment_id: string | null;
  host: string;
  checks: string[];
  status: string;
  requests: Generated<number>;
  found: JsonDefault<unknown[]>;
  notes: JsonDefault<unknown[]>;
  override_by: string | null;
  error: string | null;
  started_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}

export interface ApiLoadTestTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  body: Json<Record<string, unknown>>;
  updated_by: string;
  updated_at: Timestamp;
}

export interface ApiLoadRunTable {
  id: Generated<string>;
  org_id: string;
  project_id: string;
  load_test_id: string;
  user_id: string;
  host: string;
  status: string;
  metrics: JsonDefault<Record<string, unknown>>;
  verdicts: JsonDefault<unknown[]>;
  override_by: string | null;
  error: string | null;
  started_at: Timestamp;
  updated_at: Timestamp;
  finished_at: NullableTimestamp;
}

export interface ApiAuthSessionTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  profile_id: string;
  environment_id: string | null;
  token_enc: string;
  expires_at: NullableTimestamp;
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
  'studio.site_page': SitePageTable;
  'studio.workflow_plan': WorkflowPlanTable;
  'studio.auto_run': AutoRunTable;
  'studio.auto_run_item': AutoRunItemTable;
  'studio.code_file': CodeFileTable;
  'studio.code_file_version': CodeFileVersionTable;
  'apitest.workspace': ApiWorkspaceTable;
  'apitest.node': ApiNodeTable;
  'apitest.variation': ApiVariationTable;
  'apitest.environment': ApiEnvironmentTable;
  'apitest.cookie_jar': ApiCookieJarTable;
  'apitest.spec': ApiSpecTable;
  'apitest.spec_version': ApiSpecVersionTable;
  'apitest.history': ApiHistoryTable;
  'apitest.client_cert': ApiClientCertTable;
  'apitest.auth_profile': ApiAuthProfileTable;
  'apitest.auth_session': ApiAuthSessionTable;
  'apitest.dependency_link': ApiDependencyLinkTable;
  'apitest.workflow': ApiWorkflowTable;
  'apitest.workflow_version': ApiWorkflowVersionTable;
  'apitest.workflow_run': ApiWorkflowRunTable;
  'apitest.lint_setting': ApiLintSettingTable;
  'apitest.enrichment_answer': ApiEnrichmentAnswerTable;
  'apitest.generated_test': ApiGeneratedTestTable;
  'apitest.suite': ApiSuiteTable;
  'apitest.mock': ApiMockTable;
  'apitest.target': ApiTargetTable;
  'apitest.finding': ApiFindingTable;
  'apitest.security_run': ApiSecurityRunTable;
  'apitest.load_test': ApiLoadTestTable;
  'apitest.load_run': ApiLoadRunTable;
  'apitest.suite_run': ApiSuiteRunTable;
  'apitest.suite_result': ApiSuiteResultTable;
}

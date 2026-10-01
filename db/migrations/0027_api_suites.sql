-- API Studio suites (docs/api-testing-plan.md §13, §15): sets of requests, variations and workflows run
-- together on a trigger (by hand, a schedule, a monitor, CI or a spec change), and their results.

CREATE TABLE apitest.suite (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  workspace_id uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- SuiteItem[]: what to run. Validated by the API.
  items        jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  -- SuiteSettings and SuiteSchedule.
  settings     jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  schedule     jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'object'),
  -- When the scheduler starts it next; null when it has no schedule or monitor.
  next_run_at  timestamptz,
  -- Scheduled runs act as this person: their cookies, sessions and permissions.
  owner_id     uuid NOT NULL,
  updated_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
-- The scheduler's query: due suites across every organisation.
CREATE INDEX suite_due_idx ON apitest.suite (next_run_at) WHERE next_run_at IS NOT NULL;

CREATE TABLE apitest.suite_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL REFERENCES repo.project (id),
  suite_id       uuid NOT NULL REFERENCES apitest.suite (id) ON DELETE CASCADE,
  trigger        text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'monitor', 'ci', 'spec_change')),
  status         text NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'error', 'cancelled')),
  environment_id uuid REFERENCES apitest.environment (id) ON DELETE SET NULL,
  -- SuiteRunTotals, kept up to date while it runs.
  totals         jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(totals) = 'object'),
  error          text,
  triggered_by   uuid,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX suite_run_recent_idx ON apitest.suite_run (org_id, suite_id, started_at DESC);

-- One row per request, variation or workflow run (per data row). `key` is stable across runs, so
-- trends can follow the same request over time.
CREATE TABLE apitest.suite_result (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  run_id       uuid NOT NULL REFERENCES apitest.suite_run (id) ON DELETE CASCADE,
  position     integer NOT NULL,
  key          text NOT NULL,
  group_name   text NOT NULL,
  name         text NOT NULL,
  row_index    integer,
  status       text NOT NULL CHECK (status IN ('passed', 'failed', 'error', 'skipped')),
  flaky        boolean NOT NULL DEFAULT false,
  attempts     integer NOT NULL DEFAULT 1,
  http_status  integer,
  duration_ms  integer NOT NULL,
  message      text NOT NULL DEFAULT '',
  history_id   uuid,
  drift_issues integer NOT NULL DEFAULT 0,
  method       text,
  operation    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX suite_result_run_idx ON apitest.suite_result (org_id, run_id, position);
CREATE INDEX suite_result_key_idx ON apitest.suite_result (org_id, key, created_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apitest.suite', 'apitest.suite_run', 'apitest.suite_result'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.suite, apitest.suite_run TO tb_app;
GRANT SELECT, INSERT, DELETE ON apitest.suite_result TO tb_app;

-- The scheduler's work list across organisations: ids only, each then handled inside its own tenant's
-- transaction as the suite's owner. SECURITY DEFINER because the scheduler has no tenant of its own.
CREATE FUNCTION apitest.suites_due(p_now timestamptz) RETURNS TABLE (org_id uuid, suite_id uuid, owner_id uuid)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = apitest, pg_temp AS $$
  SELECT s.org_id, s.id, s.owner_id FROM apitest.suite s WHERE s.next_run_at IS NOT NULL AND s.next_run_at <= p_now
$$;
REVOKE ALL ON FUNCTION apitest.suites_due(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apitest.suites_due(timestamptz) TO tb_app;

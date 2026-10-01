-- API Studio workflows (docs/api-testing-plan.md §12): the project map's link decisions, workflows that
-- call requests in order, and their runs.

-- What testers decided about an inferred link. Links themselves are computed from the specs on read;
-- only the decisions are stored, so a new spec version keeps them wherever the operations still exist.
CREATE TABLE apitest.dependency_link (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  -- Operation keys, "POST /orders".
  from_key   text NOT NULL CHECK (length(from_key) BETWEEN 3 AND 2100),
  to_key     text NOT NULL CHECK (length(to_key) BETWEEN 3 AND 2100),
  param_in   text NOT NULL CHECK (param_in IN ('path', 'query', 'header', 'body', 'auth')),
  param_name text NOT NULL CHECK (length(param_name) BETWEEN 1 AND 200),
  -- JSONPath in the producer's response; null for auth links.
  field      text CHECK (field IS NULL OR length(field) <= 500),
  status     text NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, from_key, to_key, param_in, param_name)
);

CREATE TABLE apitest.workflow (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  workspace_id    uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  current_version integer NOT NULL DEFAULT 1,
  updated_by      uuid NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- Immutable: a run pins the version it ran, so its results stay explainable after the workflow changes.
CREATE TABLE apitest.workflow_version (
  workflow_id uuid NOT NULL REFERENCES apitest.workflow (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  org_id      uuid NOT NULL,
  -- ApiWorkflowDef: { variables, steps, teardown }. Validated by the API.
  def         jsonb NOT NULL CHECK (jsonb_typeof(def) = 'object'),
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, version)
);
CREATE TRIGGER workflow_version_immutable BEFORE UPDATE ON apitest.workflow_version
  FOR EACH ROW EXECUTE FUNCTION apitest.forbid_version_change();

-- A run, per tester. Step mode pauses between top-level steps; `state` carries the variables and the
-- saved-session context between them, encrypted because it holds whatever the steps extracted.
CREATE TABLE apitest.workflow_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL REFERENCES repo.project (id),
  workflow_id    uuid NOT NULL REFERENCES apitest.workflow (id) ON DELETE CASCADE,
  version        integer NOT NULL,
  user_id        uuid NOT NULL,
  environment_id uuid REFERENCES apitest.environment (id) ON DELETE SET NULL,
  mode           text NOT NULL CHECK (mode IN ('all', 'step')),
  status         text NOT NULL CHECK (status IN ('running', 'paused', 'passed', 'failed', 'error', 'cancelled')),
  next_step      integer NOT NULL DEFAULT 0,
  -- ApiWorkflowStepResult[], secrets masked.
  results        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(results) = 'array'),
  state_enc      text,
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX workflow_run_recent_idx ON apitest.workflow_run (org_id, workflow_id, started_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apitest.dependency_link', 'apitest.workflow', 'apitest.workflow_version', 'apitest.workflow_run'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.dependency_link, apitest.workflow, apitest.workflow_run TO tb_app;
GRANT SELECT, INSERT ON apitest.workflow_version TO tb_app;

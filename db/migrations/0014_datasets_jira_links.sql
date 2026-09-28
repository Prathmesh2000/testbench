-- Data-driven testing and direct Jira links on test cases.

-- ---------- data sets ----------
-- A project library of test data: named columns and rows (typed in, or parsed from an uploaded CSV,
-- Excel or JSON file), plus any files testers need while testing (sample documents, images).
CREATE TABLE repo.data_set (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES repo.project (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  columns     text[] NOT NULL CHECK (cardinality(columns) BETWEEN 1 AND 50),
  -- One JSON object per row, keyed by column name. Capped at 1,000 rows: each row becomes a run item.
  rows        jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(rows) = 'array' AND jsonb_array_length(rows) <= 1000),
  version     integer NOT NULL DEFAULT 1,
  updated_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE repo.data_file (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  data_set_id uuid NOT NULL REFERENCES repo.data_set (id) ON DELETE CASCADE,
  object_key  text NOT NULL,
  file_name   text NOT NULL,
  content_type text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 104857600),
  uploaded_by uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_file_set_idx ON repo.data_file (data_set_id);

-- A case runs once per data row when it has a data set. Many cases can share one set.
ALTER TABLE repo.test_case ADD COLUMN data_set_id uuid;
CREATE INDEX test_case_data_set_idx ON repo.test_case (project_id, data_set_id) WHERE data_set_id IS NOT NULL;

-- A run item may be one data row of its case. The row's values are copied in, so later edits to the
-- data set never change what a past run executed.
ALTER TABLE exec.run_item
  ADD COLUMN data_row integer,
  ADD COLUMN data jsonb;
ALTER TABLE exec.run_item DROP CONSTRAINT run_item_run_id_case_id_config_key;
CREATE UNIQUE INDEX run_item_unique_idx ON exec.run_item (run_id, case_id, config, coalesce(data_row, -1));

-- ---------- Jira links on cases ----------
-- Any Jira issue (story, task, epic, bug) can be linked to a case directly, not only bugs logged from
-- a run. Linked issues live in defect.defect, so the webhook and reconciler keep every one in sync.
ALTER TABLE defect.defect ADD COLUMN issue_type text NOT NULL DEFAULT 'Bug';
CREATE TABLE defect.case_link (
  defect_id uuid NOT NULL REFERENCES defect.defect (id) ON DELETE CASCADE,
  case_id   uuid NOT NULL,
  org_id    uuid NOT NULL,
  project_id uuid NOT NULL,
  linked_by uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (defect_id, case_id)
);
CREATE INDEX case_link_case_idx ON defect.case_link (project_id, case_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['repo.data_set', 'repo.data_file', 'defect.case_link'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON repo.data_set, repo.data_file, defect.case_link TO tb_app;

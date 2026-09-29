-- Code workspace (testing-studio-plan §3.7): a real Playwright framework per project, for engineers
-- and anyone who prefers code: page objects, fixtures, helpers and spec files, edited in Testbench.
-- Files live here, not in Git (technical-design §2.1); every save keeps the previous content.

CREATE TABLE studio.code_file (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  -- Only the framework's own folders, so a stored path can never escape the workspace when written out.
  path       text NOT NULL CHECK (path ~ '^(pages|fixtures|utils|tests|data)/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*\.(ts|json)$'),
  content    text NOT NULL CHECK (length(content) <= 500000),
  version    integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE TABLE studio.code_file_version (
  file_id    uuid NOT NULL REFERENCES studio.code_file (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  org_id     uuid NOT NULL,
  content    text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, version)
);

-- A run freezes the whole workspace at dispatch, so every item runs the same framework code even if
-- someone edits a page object mid-run.
ALTER TABLE studio.auto_run ADD COLUMN workspace jsonb;
-- A code item runs one spec file (all its tests); a steps item runs generated code.
ALTER TABLE studio.auto_run_item ADD COLUMN spec_path text;
ALTER TABLE studio.auto_run_item ALTER COLUMN test_id DROP NOT NULL;
ALTER TABLE studio.auto_run_item ALTER COLUMN test_version DROP NOT NULL;
ALTER TABLE studio.auto_run_item ADD CONSTRAINT auto_run_item_kind CHECK ((test_id IS NULL) <> (spec_path IS NULL));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studio.code_file', 'studio.code_file_version'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON studio.code_file TO tb_app;
GRANT SELECT, INSERT ON studio.code_file_version TO tb_app;

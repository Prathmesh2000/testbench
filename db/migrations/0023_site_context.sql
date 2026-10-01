-- The site map and saved workflow plans (testing-studio-plan §3.3). Additive: new tables only.

-- Every page the Test Browser reaches, one row per stable path: its headings, what can be pressed,
-- its fields and the APIs it called, merged across visits (SitePage in contracts/site.ts).
CREATE TABLE studio.site_page (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES repo.project (id),
  path        text NOT NULL CHECK (length(path) BETWEEN 1 AND 500),
  body        jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  visits      integer NOT NULL DEFAULT 1,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

-- What testers settled for a workflow: what to test, each field's validation, the chat, the
-- scenarios with what the app did, and checks for every success (WorkflowPlan). One per workflow,
-- whatever its version: scenarios carry over, and are run again when the workflow changes.
CREATE TABLE studio.workflow_plan (
  component_id uuid PRIMARY KEY REFERENCES studio.component (id) ON DELETE CASCADE,
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  body         jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  updated_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studio.site_page', 'studio.workflow_plan'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON studio.site_page, studio.workflow_plan TO tb_app;

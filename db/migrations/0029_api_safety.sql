-- API Studio safety gate, security checks and load tests (docs/api-testing-plan.md §14).

-- A production environment: load tests and active security checks against it need an admin's override.
ALTER TABLE apitest.environment ADD COLUMN production boolean NOT NULL DEFAULT false;

-- A host the project has proved it owns, by a DNS TXT record or a file on the host. Load tests and
-- active security checks run only against verified hosts (local development hosts excepted).
CREATE TABLE apitest.target (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES repo.project (id),
  host        text NOT NULL CHECK (host ~ '^[a-z0-9.-]+(:[0-9]{1,5})?$'),
  -- What must be published: the same value for the DNS record and the file.
  token       text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified')),
  method      text CHECK (method IS NULL OR method IN ('dns', 'file')),
  verified_at timestamptz,
  verified_by uuid,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, host)
);

-- One finding per problem per operation: running the checks again updates it rather than adding a copy.
CREATE TABLE apitest.finding (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL REFERENCES repo.project (id),
  spec_id        uuid NOT NULL REFERENCES apitest.spec (id) ON DELETE CASCADE,
  fingerprint    text NOT NULL,
  rule           text NOT NULL,
  severity       text NOT NULL CHECK (severity IN ('high', 'medium', 'low', 'info')),
  owasp          text NOT NULL,
  operation      text,
  title          text NOT NULL,
  detail         text NOT NULL,
  -- { request, response }, masked before it is stored.
  evidence       jsonb NOT NULL,
  history_id     uuid,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'suppressed')),
  suppress_reason text,
  suppress_until  timestamptz,
  suppressed_by  uuid,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (spec_id, fingerprint)
);
CREATE INDEX finding_spec_idx ON apitest.finding (org_id, spec_id, status);

CREATE TABLE apitest.security_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL REFERENCES repo.project (id),
  spec_id        uuid NOT NULL REFERENCES apitest.spec (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  environment_id uuid REFERENCES apitest.environment (id) ON DELETE SET NULL,
  host           text NOT NULL,
  checks         text[] NOT NULL,
  status         text NOT NULL CHECK (status IN ('running', 'done', 'error', 'cancelled')),
  requests       integer NOT NULL DEFAULT 0,
  -- Fingerprints this run found, and notes on what it skipped and why.
  found          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(found) = 'array'),
  notes          jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(notes) = 'array'),
  override_by    uuid,
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE apitest.load_test (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  workspace_id uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- LoadTestBody.
  body         jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  updated_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE apitest.load_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  load_test_id uuid NOT NULL REFERENCES apitest.load_test (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  host         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'aborted', 'error', 'cancelled')),
  -- LoadMetrics, updated while it runs, and LoadVerdict[] once it ends.
  metrics      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metrics) = 'object'),
  verdicts     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(verdicts) = 'array'),
  override_by  uuid,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX load_run_recent_idx ON apitest.load_run (org_id, load_test_id, started_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apitest.target', 'apitest.finding', 'apitest.security_run', 'apitest.load_test', 'apitest.load_run'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.target, apitest.finding, apitest.security_run, apitest.load_test, apitest.load_run TO tb_app;

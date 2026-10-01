-- API Studio (docs/api-testing-plan.md), phase A1: workspaces with a collection/folder/request tree,
-- saved variations, environments, the spec library and send history.
CREATE SCHEMA apitest;

-- Team workspaces are shared in the project; personal ones are drafts only their owner sees. RLS stops
-- other tenants; "only the owner" is a query rule, because RLS here knows the org, not the user.
CREATE TABLE apitest.workspace (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind       text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'personal')),
  owner_id   uuid NOT NULL,
  -- ApiVariable[]; a secret's value is AES-256-GCM ciphertext (API_STUDIO_SECRET), never plain text.
  variables  jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(variables) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_team_name_idx ON apitest.workspace (project_id, lower(name)) WHERE kind = 'team';
CREATE UNIQUE INDEX workspace_personal_name_idx ON apitest.workspace (project_id, owner_id, lower(name)) WHERE kind = 'personal';

-- One tree per workspace: collections at the root, folders nest, requests are leaves. One table so a
-- move is one UPDATE of parent_id and the tree loads in one query.
CREATE TABLE apitest.node (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES apitest.node (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('collection', 'folder', 'request')),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position     integer NOT NULL DEFAULT 0,
  -- Collections and folders: { auth, variables }. Requests: ApiRequestDef. Validated by the API.
  config       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  updated_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'collection') = (parent_id IS NULL))
);
CREATE INDEX node_tree_idx ON apitest.node (org_id, workspace_id, parent_id, position);

-- A saved override of a request ("0 items", "expired token"). Each field present replaces the
-- request's own; absent fields inherit, so editing the request still flows into its variations.
CREATE TABLE apitest.variation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  request_id uuid NOT NULL REFERENCES apitest.node (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position   integer NOT NULL DEFAULT 0,
  overrides  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(overrides) = 'object'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variation_request_idx ON apitest.variation (org_id, request_id, position);

CREATE TABLE apitest.environment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position     integer NOT NULL DEFAULT 0,
  -- Same shape and encryption rule as workspace.variables.
  variables    jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(variables) = 'array'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- The "saved per environment" cookie option (plan §16.5): one jar per person, workspace and environment.
-- Credentials, so the whole jar is encrypted; it expires with the cookies inside it.
CREATE TABLE apitest.cookie_jar (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  user_id        uuid NOT NULL,
  workspace_id   uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  environment_id uuid REFERENCES apitest.environment (id) ON DELETE CASCADE,
  cookies_enc    text NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- Null environment is its own jar ("no environment"), so it is folded into the key.
CREATE UNIQUE INDEX cookie_jar_owner_idx ON apitest.cookie_jar
  (user_id, workspace_id, coalesce(environment_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE apitest.spec (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES repo.project (id),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Where the spec was fetched from, so it can be synced again; null for uploads.
  source_url      text CHECK (source_url IS NULL OR length(source_url) <= 2000),
  current_version integer NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- Immutable: tests and diffs refer to a version, so it must not change under them. The document is
-- in S3 (up to 20 MB); the operation list is here so the catalog and diffs never read S3.
CREATE TABLE apitest.spec_version (
  spec_id     uuid NOT NULL REFERENCES apitest.spec (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  org_id      uuid NOT NULL,
  format      text NOT NULL CHECK (format IN ('openapi3', 'swagger2')),
  title       text NOT NULL,
  api_version text NOT NULL,
  -- sha256 of the normalised document: re-uploading an unchanged spec makes no new version.
  hash        text NOT NULL,
  storage_key text NOT NULL,
  size_bytes  integer NOT NULL,
  operations  jsonb NOT NULL CHECK (jsonb_typeof(operations) = 'array'),
  -- Base URLs the spec declares, offered as {{baseUrl}} when requests are made from it.
  servers     text[] NOT NULL DEFAULT '{}',
  -- SpecDiff against the previous version; null for version 1.
  diff        jsonb,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (spec_id, version)
);

CREATE FUNCTION apitest.forbid_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'spec versions are immutable';
END $$;
CREATE TRIGGER spec_version_immutable BEFORE UPDATE ON apitest.spec_version
  FOR EACH ROW EXECUTE FUNCTION apitest.forbid_version_change();

-- Every send from the builder, per person. Request and response are stored after masking: secret values
-- are replaced before the row is written, and bodies are cut to a preview.
-- ponytail: rows kept until deleted; a 30-day cleanup job (plan §4) arrives with the suite runner.
CREATE TABLE apitest.history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  workspace_id uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  node_id      uuid REFERENCES apitest.node (id) ON DELETE SET NULL,
  method       text NOT NULL,
  url          text NOT NULL,
  -- Null when the request never got a response (blocked, timed out, refused).
  status       integer,
  duration_ms  integer NOT NULL,
  request      jsonb NOT NULL,
  response     jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_user_idx ON apitest.history (org_id, user_id, workspace_id, created_at DESC);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apitest.workspace', 'apitest.node', 'apitest.variation', 'apitest.environment',
    'apitest.cookie_jar', 'apitest.spec', 'apitest.spec_version', 'apitest.history'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA apitest TO tb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.workspace, apitest.node, apitest.variation, apitest.environment,
  apitest.cookie_jar, apitest.spec TO tb_app;
GRANT SELECT, INSERT ON apitest.spec_version TO tb_app;
GRANT SELECT, INSERT, DELETE ON apitest.history TO tb_app;

-- M4: PRDs with requirements and change impact, release sign-off, and the AI provider layer's
-- per-tenant configuration and usage meter.

CREATE SCHEMA docs;
CREATE SCHEMA analytics;
CREATE SCHEMA ai;
GRANT USAGE ON SCHEMA docs, analytics, ai TO tb_app;

-- Health, build comparison and traceability all ask "what happened to this case lately?".
CREATE INDEX run_item_case_idx ON exec.run_item (project_id, case_id, updated_at DESC);

-- ---------- documents ----------
CREATE TABLE docs.document (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES repo.project (id),
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_version integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_project_idx ON docs.document (project_id, updated_at DESC);

-- Every upload is kept, with the requirement list extracted from it, so any two versions can be
-- compared later without extracting again.
CREATE TABLE docs.document_version (
  document_id  uuid NOT NULL REFERENCES docs.document (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  org_id       uuid NOT NULL,
  body         text NOT NULL CHECK (length(body) <= 2000000),
  requirements jsonb NOT NULL,
  extracted_by text NOT NULL,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version)
);

-- The latest state of each requirement, plus how it changed in the latest version. A removed
-- requirement stays (change = 'removed') so its links still explain why cases were flagged.
CREATE TABLE docs.requirement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  document_id   uuid NOT NULL REFERENCES docs.document (id) ON DELETE CASCADE,
  ref           text NOT NULL CHECK (length(ref) BETWEEN 1 AND 40),
  title         text NOT NULL,
  text          text NOT NULL,
  position      integer NOT NULL,
  change        text NOT NULL DEFAULT 'added' CHECK (change IN ('unchanged', 'added', 'changed', 'removed')),
  changed_in    integer NOT NULL,
  UNIQUE (document_id, ref)
);

CREATE TABLE docs.requirement_case (
  requirement_id uuid NOT NULL REFERENCES docs.requirement (id) ON DELETE CASCADE,
  case_id        uuid NOT NULL,
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL,
  linked_by      uuid NOT NULL,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requirement_id, case_id)
);
CREATE INDEX requirement_case_case_idx ON docs.requirement_case (project_id, case_id);

-- A case whose requirement changed ("needs review") or disappeared ("possibly obsolete"). The case
-- still runs; the flag is cleared when its owner confirms it or edits it (HLD §5.13).
CREATE TABLE docs.case_flag (
  case_id        uuid NOT NULL,
  requirement_id uuid NOT NULL REFERENCES docs.requirement (id) ON DELETE CASCADE,
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('needs_review', 'possibly_obsolete')),
  reason         text NOT NULL,
  flagged_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, requirement_id)
);
CREATE INDEX case_flag_project_idx ON docs.case_flag (project_id, flagged_at DESC);

-- ---------- release sign-off ----------
CREATE TABLE analytics.signoff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  build      text NOT NULL,
  decision   text NOT NULL CHECK (decision IN ('go', 'no_go')),
  note       text NOT NULL DEFAULT '',
  -- The criteria as evaluated when the decision was made, so the record doesn't change as results do.
  criteria   jsonb NOT NULL,
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signoff_build_idx ON analytics.signoff (project_id, build, decided_at DESC);

-- ---------- AI ----------
CREATE TABLE ai.config (
  org_id        uuid PRIMARY KEY,
  policy        text NOT NULL DEFAULT 'any' CHECK (policy IN ('any', 'allowed', 'local_only', 'off')),
  allowed       text[] NOT NULL DEFAULT '{}',
  -- Per-task { provider, model, fallback[] } overrides; tasks not listed use the platform default.
  tasks         jsonb NOT NULL DEFAULT '{}',
  monthly_budget bigint NOT NULL DEFAULT 10000000 CHECK (monthly_budget >= 0),
  -- Tenant keys (BYOK), encrypted by the application: provider -> { ciphertext, hint }. Never returned.
  keys          jsonb NOT NULL DEFAULT '{}',
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai.usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  user_id       uuid,
  task          text NOT NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  ok            boolean NOT NULL,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_org_idx ON ai.usage (org_id, created_at DESC);

-- ---------- RLS and grants ----------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['docs.document', 'docs.document_version', 'docs.requirement', 'docs.requirement_case',
                           'docs.case_flag', 'analytics.signoff', 'ai.config', 'ai.usage'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON docs.document, docs.requirement, ai.config TO tb_app;
GRANT SELECT, INSERT ON docs.document_version, analytics.signoff, ai.usage TO tb_app;
GRANT SELECT, INSERT, DELETE ON docs.requirement_case TO tb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON docs.case_flag TO tb_app;

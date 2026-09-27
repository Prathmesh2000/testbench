-- Test repository: projects, the functionality tree, test cases and their immutable versions.
-- Sized for 10M cases in one project (HLD §3.1).

CREATE TABLE repo.project (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES iam.org (id),
  key          text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name         text NOT NULL,
  -- Counters for human-readable keys (TC-10231, RUN-231). Incremented with UPDATE … RETURNING so two
  -- concurrent creates can never be handed the same number.
  next_case_no integer NOT NULL DEFAULT 10001,
  next_run_no  integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);

-- Functionality tree. `path` is an ltree of module ids (hyphens stripped), so "everything under
-- UPI" is one indexed `path <@ $1` query no matter how deep the tree goes.
CREATE TABLE repo.module (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  parent_id  uuid REFERENCES repo.module (id),
  name       text NOT NULL,
  path       ltree NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  UNIQUE NULLS NOT DISTINCT (project_id, parent_id, name)
);
CREATE INDEX module_path_gist ON repo.module USING gist (project_id, path);

-- Current state of each case. Content history lives in repo.case_version; this row holds the latest
-- title (for sorting and search) plus workflow metadata (status, owner, labels…), which changes far more
-- often than content and does not need a version of its own. Changes to it are recorded as outbox events.
-- Hash-partitioned by project so vacuum and index maintenance stay bounded per partition as the total
-- across tenants grows. One 10M-case project lives in one partition, which Postgres handles fine.
CREATE TABLE repo.test_case (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL,
  key_no          integer NOT NULL,
  module_id       uuid NOT NULL,
  title           text NOT NULL,
  priority        text NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  type            text NOT NULL DEFAULT 'Functional',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'ready', 'needs_review', 'obsolete')),
  owner_id        uuid,
  labels          text[] NOT NULL DEFAULT '{}',
  custom          jsonb NOT NULL DEFAULT '{}',
  estimate_min    integer,
  automation      text NOT NULL DEFAULT 'manual' CHECK (automation IN ('manual', 'automated', 'flaky')),
  last_result     text NOT NULL DEFAULT 'untested' CHECK (last_result IN ('passed', 'failed', 'blocked', 'skipped', 'untested')),
  last_run_at     timestamptz,
  current_version integer NOT NULL DEFAULT 1,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, key_no)
) PARTITION BY HASH (project_id);

CREATE INDEX test_case_module_idx ON repo.test_case (project_id, module_id, key_no);
CREATE INDEX test_case_updated_idx ON repo.test_case (project_id, updated_at, id);
CREATE INDEX test_case_labels_gin ON repo.test_case USING gin (labels);
CREATE INDEX test_case_title_trgm ON repo.test_case USING gin (title gin_trgm_ops);

-- Every version of a case's content. Rows are never modified: a run item points at (case, version), and
-- rewriting a version would silently change what past runs claim to have tested.
CREATE TABLE repo.case_version (
  project_id    uuid NOT NULL,
  case_id       uuid NOT NULL,
  version       integer NOT NULL,
  org_id        uuid NOT NULL,
  title         text NOT NULL,
  preconditions text NOT NULL DEFAULT '',
  format        text NOT NULL DEFAULT 'steps' CHECK (format IN ('steps', 'gherkin')),
  -- Array of {action, expected, data}. Always read and written together with the version, so one JSONB
  -- value instead of one row per step (10M cases × 3 versions × 10 steps would be ~300M rows).
  steps         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  gherkin       text,
  note          text NOT NULL DEFAULT '',
  author_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, case_id, version)
) PARTITION BY HASH (project_id);

CREATE FUNCTION repo.reject_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'case versions are immutable; insert a new version instead' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER case_version_immutable BEFORE UPDATE OR DELETE ON repo.case_version
  FOR EACH ROW EXECUTE FUNCTION repo.reject_version_change();

DO $$
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format('CREATE TABLE repo.test_case_p%s PARTITION OF repo.test_case FOR VALUES WITH (MODULUS 32, REMAINDER %s)', i, i);
    EXECUTE format('CREATE TABLE repo.case_version_p%s PARTITION OF repo.case_version FOR VALUES WITH (MODULUS 32, REMAINDER %s)', i, i);
  END LOOP;
END $$;

-- "TC-A depends on TC-B": B must pass before A is worth running (HLD §5.3). Kept acyclic by the API.
CREATE TABLE repo.case_dependency (
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  case_id       uuid NOT NULL,
  depends_on_id uuid NOT NULL,
  PRIMARY KEY (project_id, case_id, depends_on_id),
  CHECK (case_id <> depends_on_id)
);
CREATE INDEX case_dependency_reverse_idx ON repo.case_dependency (project_id, depends_on_id);

-- Per-module counts so the tree never runs COUNT(*) over millions of cases.
CREATE TABLE repo.module_stats (
  module_id  uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL,
  total      integer NOT NULL DEFAULT 0,
  failing    integer NOT NULL DEFAULT 0
);

-- ponytail: row-level trigger keeps counts exact and simple. A bulk move of millions of cases pays one
-- stats update per row; switch to an event-driven rollup (HLD §3.1) when that shows up in profiles.
CREATE FUNCTION repo.track_module_stats() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE repo.module_stats
       SET total = total - 1,
           failing = failing - (OLD.last_result = 'failed')::int
     WHERE module_id = OLD.module_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO repo.module_stats AS s (module_id, org_id, project_id, total, failing)
    VALUES (NEW.module_id, NEW.org_id, NEW.project_id, 1, (NEW.last_result = 'failed')::int)
    ON CONFLICT (module_id) DO UPDATE
      SET total = s.total + 1, failing = s.failing + (NEW.last_result = 'failed')::int;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER test_case_module_stats
  AFTER INSERT OR DELETE OR UPDATE OF module_id, last_result ON repo.test_case
  FOR EACH ROW EXECUTE FUNCTION repo.track_module_stats();

-- Bulk edits are driven by a filter, not an ID list ("select all 12,480 matching"), and processed in
-- chunks by a worker. `cursor` is the last case id finished, so a crashed job resumes where it stopped.
CREATE TABLE repo.bulk_job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL,
  filter      jsonb NOT NULL,
  patch       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  total       integer NOT NULL DEFAULT 0,
  processed   integer NOT NULL DEFAULT 0,
  cursor      uuid,
  error       text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX bulk_job_pending_idx ON repo.bulk_job (created_at) WHERE status IN ('queued', 'running');

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project', 'module', 'test_case', 'case_version', 'case_dependency', 'module_stats', 'bulk_job'] LOOP
    EXECUTE format('ALTER TABLE repo.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON repo.%I USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON repo.project, repo.module, repo.test_case, repo.case_dependency, repo.module_stats, repo.bulk_job TO tb_app;
-- Belt and braces with the trigger: the app role cannot even attempt to change a version.
GRANT SELECT, INSERT ON repo.case_version TO tb_app;

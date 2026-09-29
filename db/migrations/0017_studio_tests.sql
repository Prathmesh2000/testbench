-- Automated tests as structured steps (testing-studio-plan §3–§5, technical-design §2.1). Steps are
-- the source of truth; Playwright code is generated from a pinned version, never stored.

CREATE TABLE studio.test (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES repo.project (id),
  key_no          integer NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  kind            text NOT NULL DEFAULT 'ui' CHECK (kind IN ('ui', 'api', 'journey')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'quarantined', 'archived')),
  case_id         uuid,
  data_set_id     uuid REFERENCES repo.data_set (id),
  current_version integer NOT NULL DEFAULT 1,
  owner_id        uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key_no)
);
CREATE INDEX test_case_idx ON studio.test (project_id, case_id) WHERE case_id IS NOT NULL;

-- Immutable: a run pins the version it ran, so results stay explainable after the test is edited.
CREATE TABLE studio.test_version (
  test_id    uuid NOT NULL REFERENCES studio.test (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  org_id     uuid NOT NULL,
  steps      jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  secrets    text[] NOT NULL DEFAULT '{}',
  warnings   jsonb NOT NULL DEFAULT '[]',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (test_id, version)
);

CREATE FUNCTION studio.forbid_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'test versions are immutable';
END $$;
CREATE TRIGGER test_version_immutable BEFORE UPDATE ON studio.test_version
  FOR EACH ROW EXECUTE FUNCTION studio.forbid_version_change();

-- Central locators: tests refer to elements by id, so one fix repairs every test that uses it.
CREATE TABLE studio.page_element (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  page       text NOT NULL CHECK (length(page) BETWEEN 1 AND 120),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  locators   jsonb NOT NULL CHECK (jsonb_typeof(locators) = 'array'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, page, name)
);

-- Reusable steps. Tests pin a component version; publishing a new one never changes them silently.
CREATE TABLE studio.component (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES repo.project (id),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  description     text NOT NULL DEFAULT '',
  inputs          text[] NOT NULL DEFAULT '{}',
  current_version integer NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE studio.component_version (
  component_id uuid NOT NULL REFERENCES studio.component (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  org_id       uuid NOT NULL,
  steps        jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  inputs       text[] NOT NULL DEFAULT '{}',
  changelog    text NOT NULL DEFAULT '',
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component_id, version)
);
CREATE TRIGGER component_version_immutable BEFORE UPDATE ON studio.component_version
  FOR EACH ROW EXECUTE FUNCTION studio.forbid_version_change();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studio.test', 'studio.test_version', 'studio.page_element', 'studio.component', 'studio.component_version'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON studio.test, studio.page_element, studio.component TO tb_app;
GRANT SELECT, INSERT ON studio.test_version, studio.component_version TO tb_app;

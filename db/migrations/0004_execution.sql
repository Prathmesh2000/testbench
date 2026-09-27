-- Execution: runs, their items, step results and evidence.

CREATE TABLE exec.run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES repo.project (id),
  key_no      integer NOT NULL,
  name        text NOT NULL,
  type        text NOT NULL DEFAULT 'custom' CHECK (type IN ('smoke', 'regression', 'custom', 'exploratory', 'automated')),
  environment text NOT NULL,
  build       text NOT NULL,
  configs     text[] NOT NULL CHECK (cardinality(configs) > 0),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('preparing', 'active', 'completed')),
  due_at      timestamptz,
  -- Denormalised counters, updated in the same transaction as each result, so run lists and Home show
  -- progress without aggregating run_item on every render.
  total       integer NOT NULL DEFAULT 0,
  passed      integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  blocked     integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key_no)
);

-- One case × one configuration within a run. It points at the exact case version that was frozen when
-- the run was created, so editing the case later does not rewrite what this run tested.
CREATE TABLE exec.run_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL,
  run_id         uuid NOT NULL REFERENCES exec.run (id),
  case_id        uuid NOT NULL,
  case_version   integer NOT NULL,
  config         text NOT NULL,
  position       integer NOT NULL,
  assignee_id    uuid,
  status         text NOT NULL DEFAULT 'untested' CHECK (status IN ('passed', 'failed', 'blocked', 'skipped', 'untested')),
  -- Latest status per step, in step order. The full history is in exec.step_result; this copy lets the
  -- execute view render a case without replaying the log.
  step_status    jsonb NOT NULL DEFAULT '[]',
  blocked_by     uuid REFERENCES exec.run_item (id),
  blocked_reason text,
  duration_s     integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, case_id, config)
);
CREATE INDEX run_item_run_idx ON exec.run_item (run_id, position);
CREATE INDEX run_item_assignee_idx ON exec.run_item (assignee_id, status);

-- Append-only log of every step result ever recorded, partitioned by month because it is the fastest
-- growing table and old months can be detached and archived without touching the live ones.
CREATE TABLE exec.step_result (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  org_id       uuid NOT NULL,
  run_item_id  uuid NOT NULL,
  step_index   integer NOT NULL CHECK (step_index >= 0),
  status       text NOT NULL CHECK (status IN ('passed', 'failed', 'blocked', 'skipped')),
  actual       text,
  recorded_by  uuid NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);
CREATE INDEX step_result_item_idx ON exec.step_result (run_item_id, step_index, recorded_at DESC);

-- ponytail: partitions are pre-created through 2027 plus a default catch-all. Add a monthly job that
-- creates the next partition before M6 (production); the default partition keeps inserts working meanwhile.
DO $$
DECLARE
  m date := date '2026-09-01';
BEGIN
  WHILE m < date '2028-01-01' LOOP
    EXECUTE format('CREATE TABLE exec.step_result_%s PARTITION OF exec.step_result FOR VALUES FROM (%L) TO (%L)',
                   to_char(m, 'YYYY_MM'), m, m + interval '1 month');
    m := m + interval '1 month';
  END LOOP;
END $$;
CREATE TABLE exec.step_result_default PARTITION OF exec.step_result DEFAULT;

CREATE TABLE exec.evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  run_item_id  uuid NOT NULL REFERENCES exec.run_item (id),
  step_index   integer NOT NULL,
  object_key   text NOT NULL UNIQUE,
  file_name    text NOT NULL,
  content_type text NOT NULL,
  size_bytes   integer NOT NULL,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_item_idx ON exec.evidence (run_item_id);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run', 'run_item', 'step_result', 'evidence'] LOOP
    EXECUTE format('ALTER TABLE exec.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON exec.%I USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON exec.run, exec.run_item TO tb_app;
GRANT SELECT, INSERT ON exec.step_result, exec.evidence TO tb_app;

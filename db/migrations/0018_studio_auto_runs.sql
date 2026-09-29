-- Automated runs (testing-studio-plan §12, technical-design §5.3). One item per test × data row, with
-- the generated code frozen at dispatch, so a run always executes exactly what was queued.

CREATE TABLE studio.auto_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  key_no       integer NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  base_url     text NOT NULL CHECK (base_url ~ '^https?://'),
  variables    jsonb NOT NULL DEFAULT '{}',
  -- Tests in flight at once for this run: protects the app under test and shares runners fairly.
  max_parallel integer NOT NULL DEFAULT 10 CHECK (max_parallel BETWEEN 1 AND 10),
  trigger      text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'ci', 'schedule')),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'cancelled')),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (project_id, key_no)
);

CREATE TABLE studio.auto_run_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  run_id       uuid NOT NULL REFERENCES studio.auto_run (id) ON DELETE CASCADE,
  test_id      uuid NOT NULL REFERENCES studio.test (id),
  test_version integer NOT NULL,
  data_row     integer,
  data         jsonb NOT NULL DEFAULT '{}',
  code         text NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'passed', 'failed', 'skipped', 'error', 'cancelled')),
  attempt      integer NOT NULL DEFAULT 0,
  -- Passed only on a retry: reported as flaky, never as a clean pass.
  flaky        boolean NOT NULL DEFAULT false,
  error        text,
  steps        jsonb NOT NULL DEFAULT '[]',
  evidence     jsonb NOT NULL DEFAULT '[]',
  duration_ms  integer,
  started_at   timestamptz,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auto_run_item_run_idx ON studio.auto_run_item (run_id, status);
CREATE INDEX auto_run_item_queue_idx ON studio.auto_run_item (updated_at) WHERE status IN ('queued', 'running');

-- Runners have no tenant: they claim across organisations here, then work inside the item's tenant.
-- An item is only claimable while its run has fewer than max_parallel items running; runs take turns
-- by oldest-waiting first. 'running' rows untouched for 15 minutes belong to a runner that died.
CREATE FUNCTION studio.claim_run_item() RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = studio, pg_temp AS $$
  UPDATE studio.auto_run_item i
     SET status = 'running', attempt = i.attempt + 1, started_at = now(), updated_at = now()
   WHERE i.id = (
     SELECT q.id FROM studio.auto_run_item q
       JOIN studio.auto_run r ON r.id = q.run_id
      WHERE r.status IN ('queued', 'running')
        AND (q.status = 'queued' OR (q.status = 'running' AND q.updated_at < now() - interval '15 minutes'))
        AND (SELECT count(*) FROM studio.auto_run_item b
              WHERE b.run_id = q.run_id AND b.status = 'running'
                AND b.updated_at >= now() - interval '15 minutes') < r.max_parallel
      ORDER BY q.updated_at
      FOR UPDATE OF q SKIP LOCKED
      LIMIT 1)
  RETURNING i.id, i.org_id
$$;
REVOKE ALL ON FUNCTION studio.claim_run_item() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION studio.claim_run_item() TO tb_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studio.auto_run', 'studio.auto_run_item'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON studio.auto_run, studio.auto_run_item TO tb_app;

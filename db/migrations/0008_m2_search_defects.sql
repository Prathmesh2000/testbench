-- M2: outbox relay bookkeeping, saved filters, Jira defects and retests, background run preparation.

CREATE SCHEMA search;
CREATE SCHEMA defect;
GRANT USAGE ON SCHEMA search, defect TO tb_app;

-- ---------- outbox relay ----------
-- A claimed event is invisible to other relays until claimed_until, so a crashed relay's claim expires
-- and another picks the event up. Events that keep failing stop after 10 attempts (dead_at) instead of
-- blocking the queue; they stay in the table for inspection.
ALTER TABLE outbox.event
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error text,
  ADD COLUMN dead_at timestamptz;
DROP INDEX outbox.event_unpublished_idx;
CREATE INDEX event_pending_idx ON outbox.event (occurred_at) WHERE published_at IS NULL AND dead_at IS NULL;

-- The relay works across every organisation, which RLS would hide from tb_app; these two narrow
-- functions are the only cross-tenant access it has.
CREATE FUNCTION outbox.claim_events(p_limit integer) RETURNS SETOF outbox.event
  LANGUAGE sql SECURITY DEFINER SET search_path = outbox, pg_temp AS $$
  UPDATE outbox.event e
     SET claimed_until = now() + interval '1 minute', attempts = e.attempts + 1
   WHERE e.id IN (
     SELECT q.id FROM outbox.event q
      WHERE q.published_at IS NULL AND q.dead_at IS NULL AND (q.claimed_until IS NULL OR q.claimed_until < now())
      ORDER BY q.occurred_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit)
  RETURNING e.*
$$;

CREATE FUNCTION outbox.finish_event(p_id uuid, p_error text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = outbox, pg_temp AS $$
  UPDATE outbox.event
     SET published_at = CASE WHEN p_error IS NULL THEN now() END,
         last_error = p_error,
         claimed_until = NULL,
         dead_at = CASE WHEN p_error IS NOT NULL AND attempts >= 10 THEN now() END
   WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION outbox.claim_events(integer), outbox.finish_event(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox.claim_events(integer), outbox.finish_event(uuid, text) TO tb_app;

-- Delivery is at-least-once, so each consumer records the events it has applied, in the same
-- transaction as its effect; a redelivered event then finds its row and is skipped.
CREATE TABLE outbox.processed (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  org_id       uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

-- ---------- saved filters ----------
CREATE TABLE search.saved_filter (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  tql        text NOT NULL CHECK (length(tql) <= 4000),
  owner_id   uuid NOT NULL,
  shared     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_filter_project_idx ON search.saved_filter (project_id, name);

-- Stored now; notifications for new matches are sent once the notification service exists (M3).
CREATE TABLE search.filter_subscription (
  filter_id  uuid NOT NULL REFERENCES search.saved_filter (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  org_id     uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (filter_id, user_id)
);

-- ---------- defects ----------
-- One row per Jira issue linked to a project. Jira is the source of truth for status; these columns
-- are the last synced copy (webhook or reconciler), used for lists and the retest queue.
CREATE TABLE defect.defect (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES repo.project (id),
  jira_key        text NOT NULL,
  jira_id         text,
  summary         text NOT NULL,
  status          text NOT NULL,
  status_category text NOT NULL CHECK (status_category IN ('new', 'indeterminate', 'done')),
  severity        text NOT NULL DEFAULT 'Major' CHECK (severity IN ('Blocker', 'Critical', 'Major', 'Minor', 'Trivial')),
  assignee_name   text,
  fix_version     text,
  jira_updated_at timestamptz,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, jira_key)
);
CREATE INDEX defect_summary_trgm ON defect.defect USING gin (summary gin_trgm_ops);
CREATE INDEX defect_open_idx ON defect.defect (project_id, status_category);

-- Which run items (and so which cases, builds and configurations) found the defect.
CREATE TABLE defect.item_link (
  defect_id   uuid NOT NULL REFERENCES defect.defect (id),
  run_item_id uuid NOT NULL REFERENCES exec.run_item (id),
  org_id      uuid NOT NULL,
  case_id     uuid NOT NULL,
  linked_by   uuid NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (defect_id, run_item_id)
);
CREATE INDEX item_link_item_idx ON defect.item_link (run_item_id);
CREATE INDEX item_link_case_idx ON defect.item_link (case_id);

-- When Jira says a defect is done, each linked case needs re-running on the fix build (HLD §5.14).
CREATE TABLE defect.retest (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  defect_id    uuid NOT NULL REFERENCES defect.defect (id),
  case_id      uuid NOT NULL,
  assignee_id  uuid,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed')),
  build        text,
  note         text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  done_by      uuid,
  done_at      timestamptz
);
-- At most one open retest per defect and case: a second "Done" webhook must not queue a duplicate.
CREATE UNIQUE INDEX retest_one_pending ON defect.retest (defect_id, case_id) WHERE status = 'pending';

-- Timeline for the defect drawer: created, linked again, status changes, retests.
CREATE TABLE defect.event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     uuid NOT NULL,
  defect_id  uuid NOT NULL REFERENCES defect.defect (id),
  kind       text NOT NULL,
  detail     text NOT NULL,
  actor      uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX defect_event_idx ON defect.event (defect_id, created_at);

-- Per-project reconciler bookmark: the next run asks Jira only for issues updated since then.
CREATE TABLE defect.sync_state (
  project_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  last_run_at  timestamptz NOT NULL,
  last_error   text
);

-- Jira webhooks arrive without a tenant; this finds which project(s) hold a Jira key so the handler
-- can switch into that tenant. Returns ids only.
CREATE FUNCTION defect.locate_jira_key(p_key text) RETURNS TABLE (org_id uuid, project_id uuid)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = defect, pg_temp AS $$
  SELECT d.org_id, d.project_id FROM defect.defect d WHERE d.jira_key = p_key
$$;
-- The reconciler's work list: every project with linked defects that are not done yet.
CREATE FUNCTION defect.projects_to_reconcile() RETURNS TABLE (org_id uuid, project_id uuid)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = defect, pg_temp AS $$
  SELECT DISTINCT d.org_id, d.project_id FROM defect.defect d WHERE d.status_category <> 'done'
$$;
REVOKE ALL ON FUNCTION defect.locate_jira_key(text), defect.projects_to_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION defect.locate_jira_key(text), defect.projects_to_reconcile() TO tb_app;

-- ---------- background run preparation ----------
-- Runs above the synchronous limit are expanded in chunks by a worker (HLD §3.1); testers can start on
-- the items already created while the rest are written.
CREATE TABLE exec.run_prep (
  run_id      uuid PRIMARY KEY REFERENCES exec.run (id),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL,
  filter      jsonb NOT NULL,
  assignees   uuid[] NOT NULL DEFAULT '{}',
  cursor_path text,
  cursor_key  integer,
  cases_done  integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  error       text,
  created_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION exec.claim_run_prep() RETURNS TABLE (run_id uuid, org_id uuid, created_by uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = exec, pg_temp AS $$
  UPDATE exec.run_prep p
     SET status = 'running', updated_at = now()
   WHERE p.run_id = (
     SELECT q.run_id FROM exec.run_prep q
      WHERE q.status = 'queued' OR (q.status = 'running' AND q.updated_at < now() - interval '2 minutes')
      ORDER BY q.updated_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING p.run_id, p.org_id, p.created_by
$$;
REVOKE ALL ON FUNCTION exec.claim_run_prep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION exec.claim_run_prep() TO tb_app;

-- ---------- RLS and grants ----------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox.processed', 'search.saved_filter', 'search.filter_subscription', 'defect.defect',
                           'defect.item_link', 'defect.retest', 'defect.event', 'defect.sync_state', 'exec.run_prep'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON outbox.processed TO tb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON search.saved_filter, search.filter_subscription TO tb_app;
GRANT SELECT, INSERT, UPDATE ON defect.defect, defect.retest, defect.sync_state, exec.run_prep TO tb_app;
GRANT SELECT, INSERT ON defect.item_link, defect.event TO tb_app;

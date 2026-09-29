-- Testing Studio (docs/testing-studio-plan.md). Starts with the Test Browser: live sessions a tester
-- opens from Testbench. The browser itself runs in browser-live; this is the record of who opened
-- what, used for the session cap now and for usage limits later.
CREATE SCHEMA studio;

CREATE TABLE studio.live_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  project_id   uuid NOT NULL REFERENCES repo.project (id),
  user_id      uuid NOT NULL,
  url          text NOT NULL CHECK (length(url) <= 2000),
  device       text NOT NULL,
  run_item_id  uuid REFERENCES exec.run_item (id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when the tester closes it; sessions also end on their own when the ticket expires.
  ended_at     timestamptz,
  expires_at   timestamptz NOT NULL
);
CREATE INDEX live_session_open_idx ON studio.live_session (org_id, expires_at) WHERE ended_at IS NULL;

ALTER TABLE studio.live_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON studio.live_session
  USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org());

GRANT USAGE ON SCHEMA studio TO tb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON studio.live_session TO tb_app;

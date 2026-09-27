-- M5: boards (live documents, sheets, whiteboards) and meetings with action items.

CREATE SCHEMA collab;
CREATE SCHEMA meet;
GRANT USAGE ON SCHEMA collab, meet TO tb_app;

CREATE TABLE collab.board (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  kind       text NOT NULL CHECK (kind IN ('doc', 'sheet', 'whiteboard')),
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived   boolean NOT NULL DEFAULT false
);
CREATE INDEX board_project_idx ON collab.board (project_id, updated_at DESC);

-- The Yjs document of each board, written by the collaboration server a moment after edits settle.
-- ponytail: whole-state rows; add S3 snapshots and an update log if boards grow past a few MB.
CREATE TABLE collab.board_state (
  board_id   uuid PRIMARY KEY REFERENCES collab.board (id) ON DELETE CASCADE,
  org_id     uuid NOT NULL,
  state      bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meet.meeting (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES repo.project (id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  starts_at   timestamptz NOT NULL,
  minutes     integer NOT NULL CHECK (minutes BETWEEN 5 AND 480),
  attendees   uuid[] NOT NULL DEFAULT '{}',
  -- What the meeting is about, e.g. "RUN-231" or "build 8812"; shown as a link on the meeting.
  context     text,
  notes_board uuid NOT NULL REFERENCES collab.board (id),
  calendar    text NOT NULL DEFAULT 'sandbox',
  calendar_id text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_project_idx ON meet.meeting (project_id, starts_at DESC);

CREATE TABLE meet.action_item (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  meeting_id   uuid NOT NULL REFERENCES meet.meeting (id) ON DELETE CASCADE,
  text         text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  assignee_id  uuid,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'converted')),
  -- What it became: "case:TC-10231" or "task".
  converted_to text,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_item_meeting_idx ON meet.action_item (meeting_id, created_at);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['collab.board', 'collab.board_state', 'meet.meeting', 'meet.action_item'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON collab.board, collab.board_state, meet.meeting, meet.action_item TO tb_app;
GRANT DELETE ON meet.action_item TO tb_app;

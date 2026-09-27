-- Transactional outbox (HLD §2): services write events here in the same transaction as the data change,
-- so an event exists exactly when its change committed. The relay that publishes them to EventBridge
-- arrives in M2 with the first consumer; until then rows simply accumulate with published_at NULL.

CREATE TABLE outbox.event (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  project_id   uuid,
  type         text NOT NULL,
  actor        uuid,
  occurred_at  timestamptz NOT NULL,
  version      integer NOT NULL,
  data         jsonb NOT NULL,
  published_at timestamptz
);
CREATE INDEX event_unpublished_idx ON outbox.event (occurred_at) WHERE published_at IS NULL;

ALTER TABLE outbox.event ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON outbox.event USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org());

-- The app only appends. The relay will run as its own role with UPDATE.
GRANT INSERT ON outbox.event TO tb_app;

-- M5: custom roles, personal access tokens (CI, MCP, Slack) and the audit log.

CREATE SCHEMA audit;
GRANT USAGE ON SCHEMA audit TO tb_app;

-- ---------- custom roles ----------
-- A custom role starts as a copy of a built-in one. Memberships refer to it as 'custom:<id>', so the
-- built-in roles stay plain strings and every existing query keeps working.
CREATE TABLE iam.custom_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES iam.org (id),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  based_on    text NOT NULL,
  permissions text[] NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE iam.membership DROP CONSTRAINT membership_role_check;
ALTER TABLE iam.membership ADD CONSTRAINT membership_role_check
  CHECK (role IN ('org_admin', 'project_admin', 'test_lead', 'tester', 'viewer') OR role ~ '^custom:[0-9a-f-]{36}$');

-- ---------- personal access tokens ----------
-- Only a SHA-256 of the token is stored; the token itself is shown once, when it is created.
CREATE TABLE iam.token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES iam.org (id),
  user_id      uuid NOT NULL REFERENCES iam.app_user (id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  scopes       text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write']),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX token_user_idx ON iam.token (user_id, created_at DESC);

-- A token arrives before we know the tenant, which RLS keys on; this is the one narrow lookup. It also
-- records use, at most once a minute so busy CI jobs don't write on every request.
CREATE FUNCTION iam.resolve_token(p_hash text)
  RETURNS TABLE (token_id uuid, user_id uuid, org_id uuid, scopes text[], email text, name text)
  LANGUAGE sql SECURITY DEFINER SET search_path = iam, pg_temp AS $$
  WITH hit AS (
    SELECT t.id, t.user_id, t.org_id, t.scopes FROM iam.token t
     WHERE t.token_hash = p_hash AND t.revoked_at IS NULL AND t.expires_at > now()
  ), touched AS (
    UPDATE iam.token t SET last_used_at = now()
      FROM hit WHERE t.id = hit.id AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute')
  )
  SELECT hit.id, hit.user_id, hit.org_id, hit.scopes, u.email, u.name
    FROM hit JOIN iam.app_user u ON u.id = hit.user_id
$$;
REVOKE ALL ON FUNCTION iam.resolve_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.resolve_token(text) TO tb_app;

-- ---------- audit ----------
-- Where a change came from. Set per transaction like app.org_id (see withTenant), so every event
-- records it without each service having to pass it along.
ALTER TABLE outbox.event
  ADD COLUMN source text NOT NULL DEFAULT coalesce(nullif(current_setting('app.source', true), ''), 'web');

-- Append-only: tb_app may insert and read, never update or delete. Partitioned by month for retention.
CREATE TABLE audit.entry (
  id         uuid NOT NULL,
  org_id     uuid NOT NULL,
  project_id uuid,
  at         timestamptz NOT NULL,
  actor_id   uuid,
  source     text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  details    text NOT NULL,
  data       jsonb NOT NULL,
  PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);
CREATE INDEX entry_org_at_idx ON audit.entry (org_id, at DESC, id);
CREATE INDEX entry_actor_idx ON audit.entry (org_id, actor_id, at DESC);

DO $$
DECLARE
  m date := date_trunc('month', now() - interval '1 month');
BEGIN
  FOR i IN 0..14 LOOP
    EXECUTE format('CREATE TABLE audit.entry_%s PARTITION OF audit.entry FOR VALUES FROM (%L) TO (%L)',
                   to_char(m, 'YYYY_MM'), m, m + interval '1 month');
    m := m + interval '1 month';
  END LOOP;
END $$;
CREATE TABLE audit.entry_default PARTITION OF audit.entry DEFAULT;

-- ---------- RLS and grants ----------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['iam.custom_role', 'iam.token', 'audit.entry'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

-- Invitations create people before their first sign-in (resolve_user links them by email then). The
-- person may already exist in another organisation, which RLS hides, hence a definer function that
-- only ever returns the id.
CREATE FUNCTION iam.invite_user(p_email text, p_name text) RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = iam, pg_temp AS $$
  INSERT INTO iam.app_user (email, name) VALUES (lower(p_email), p_name)
  ON CONFLICT (email) DO UPDATE SET email = excluded.email
  RETURNING id
$$;
REVOKE ALL ON FUNCTION iam.invite_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.invite_user(text, text) TO tb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.custom_role TO tb_app;
GRANT SELECT, INSERT, UPDATE ON iam.token TO tb_app;
GRANT SELECT, INSERT ON audit.entry TO tb_app;

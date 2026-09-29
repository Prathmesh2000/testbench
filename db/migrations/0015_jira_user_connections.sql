-- Jira per tester: each person connects their own Jira Cloud account, so bugs, comments and
-- transitions carry their name in Jira. Replaces the single platform-wide Jira account from config.

-- ---------- connections ----------
-- One per person per organisation. The API token is encrypted by the application (AES-256-GCM,
-- JIRA_TOKEN_SECRET); only its owner's requests and the background sync ever decrypt it.
CREATE TABLE defect.jira_connection (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES iam.app_user (id),
  auth_type    text NOT NULL DEFAULT 'api_token' CHECK (auth_type IN ('api_token', 'oauth')),
  site_url     text NOT NULL CHECK (site_url ~ '^https?://[^/]+$'),
  email        text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  account_id   text NOT NULL,
  display_name text NOT NULL,
  secret_enc   text NOT NULL,
  -- 'error' once Jira refuses the stored token (revoked or expired); the owner reconnects.
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX jira_connection_site_idx ON defect.jira_connection (org_id, site_url) WHERE status = 'active';

-- ---------- project mapping ----------
-- Which Jira site and project a Testbench project files bugs into. Until now the Jira key was assumed
-- to equal the Testbench key; projects without a row keep that behaviour on their reporter's site.
CREATE TABLE defect.jira_project_map (
  project_id  uuid PRIMARY KEY REFERENCES repo.project (id),
  org_id      uuid NOT NULL,
  site_url    text NOT NULL CHECK (site_url ~ '^https?://[^/]+$'),
  jira_key    text NOT NULL CHECK (jira_key ~ '^[A-Z][A-Z0-9_]{0,9}$'),
  issue_type  text NOT NULL DEFAULT 'Bug' CHECK (length(issue_type) BETWEEN 1 AND 60),
  updated_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A defect lives on the site it was filed on, even if the project is later mapped elsewhere.
ALTER TABLE defect.defect ADD COLUMN site_url text;

-- ---------- evidence attached in Jira ----------
-- Queued when a bug is logged or linked; a worker streams each file from S3 to Jira as the person
-- who logged it. Files above the Jira site's upload limit stay as a Testbench link ('linked_only').
CREATE TABLE defect.attachment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  defect_id          uuid NOT NULL REFERENCES defect.defect (id) ON DELETE CASCADE,
  evidence_id        uuid NOT NULL REFERENCES exec.evidence (id),
  uploader_id        uuid NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'uploading', 'uploaded', 'failed', 'linked_only')),
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  jira_attachment_id text,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (defect_id, evidence_id)
);
CREATE INDEX attachment_due_idx ON defect.attachment (next_attempt_at) WHERE status IN ('pending', 'uploading');

-- The worker has no tenant, so it claims across organisations here and then works inside the claimed
-- row's tenant. 'uploading' rows older than five minutes belong to a worker that died mid-upload.
CREATE FUNCTION defect.claim_attachment() RETURNS TABLE (id uuid, org_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = defect, pg_temp AS $$
  UPDATE defect.attachment a
     SET status = 'uploading', attempts = a.attempts + 1, updated_at = now()
   WHERE a.id = (
     SELECT q.id FROM defect.attachment q
      WHERE (q.status = 'pending' AND q.next_attempt_at <= now())
         OR (q.status = 'uploading' AND q.updated_at < now() - interval '5 minutes')
      ORDER BY q.next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING a.id, a.org_id
$$;
REVOKE ALL ON FUNCTION defect.claim_attachment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION defect.claim_attachment() TO tb_app;

-- ---------- webhooks retired ----------
-- There is no platform Jira account to register a webhook with any more; the reconciler syncs with
-- each defect's reporter's connection. locate_jira_key also matched keys across organisations.
DROP FUNCTION defect.locate_jira_key(text);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['defect.jira_connection', 'defect.jira_project_map', 'defect.attachment'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON defect.jira_connection, defect.jira_project_map, defect.attachment TO tb_app;

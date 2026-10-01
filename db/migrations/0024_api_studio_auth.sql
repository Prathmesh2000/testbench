-- API Studio, rest of phase A1 (docs/api-testing-plan.md §4, §16.5): client certificates for mTLS, and
-- auth profiles that log in once and keep the session for every request that uses them.
-- 0023 is taken by the Testing Studio site-context migration being written alongside this one.

-- A client certificate (and optionally a CA for a server with a private certificate) for a host. The
-- whole bundle is encrypted with API_STUDIO_SECRET: the private key is a credential.
CREATE TABLE apitest.client_cert (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- "api.bank.test", "*.bank.test" or either with ":8443". Matched against the URL being called.
  host         text NOT NULL CHECK (host ~ '^(\*\.)?[a-z0-9.-]+(:[0-9]{1,5})?$'),
  bundle_enc   text NOT NULL,
  -- Shown without decrypting: what the certificate is and when it stops working.
  subject      text NOT NULL,
  expires_at   timestamptz,
  created_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, host)
);

-- How to log in and where the credential goes. The login itself is an ordinary request in the tree,
-- so it has its own auth, body, scripts and checks. Deleting that request leaves the profile unusable,
-- not deleted, so the requests pointing at it say why they fail.
CREATE TABLE apitest.auth_profile (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  workspace_id  uuid NOT NULL REFERENCES apitest.workspace (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  login_node_id uuid REFERENCES apitest.node (id) ON DELETE SET NULL,
  -- AuthProfileConfig: { extract, apply, ttlSeconds, reloginOn401, csrf }. Validated by the API.
  config        jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  updated_by    uuid NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- The credential a login produced, per tester, profile and environment. Encrypted; kept until it
-- expires (TTL or the token's own exp claim) or a 401 proves it stale.
CREATE TABLE apitest.auth_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  user_id        uuid NOT NULL,
  profile_id     uuid NOT NULL REFERENCES apitest.auth_profile (id) ON DELETE CASCADE,
  environment_id uuid REFERENCES apitest.environment (id) ON DELETE CASCADE,
  token_enc      text NOT NULL,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_session_owner_idx ON apitest.auth_session
  (user_id, profile_id, coalesce(environment_id, '00000000-0000-0000-0000-000000000000'::uuid));

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apitest.client_cert', 'apitest.auth_profile', 'apitest.auth_session'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.client_cert, apitest.auth_profile, apitest.auth_session TO tb_app;

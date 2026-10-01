-- API Studio mock servers (docs/api-testing-plan.md §14): one mock per spec, answering from the spec's
-- examples and schemas at an unguessable URL that needs no login, so a frontend or another service can
-- call it before the real API exists.

CREATE TABLE apitest.mock (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  spec_id    uuid NOT NULL UNIQUE REFERENCES apitest.spec (id) ON DELETE CASCADE,
  -- sha256 of the URL token, for the unauthenticated lookup; the token itself is never stored in the clear.
  token_hash text NOT NULL UNIQUE,
  -- The token encrypted with API_STUDIO_SECRET, so project members can see the URL again.
  token_enc  text NOT NULL,
  enabled    boolean NOT NULL DEFAULT false,
  -- MockConfig and per-operation MockOverride, validated by the API.
  config     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  overrides  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(overrides) = 'object'),
  -- The mock loads the spec as this person, so it sees what they can.
  owner_id   uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE apitest.mock ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON apitest.mock USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.mock TO tb_app;

-- A mock request arrives with a token and no tenant; this finds which tenant it belongs to so the handler
-- can switch into it. Returns what is needed to answer, nothing else.
CREATE FUNCTION apitest.mock_lookup(p_hash text)
  RETURNS TABLE (org_id uuid, project_id uuid, spec_id uuid, owner_id uuid, enabled boolean, config jsonb, overrides jsonb)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = apitest, pg_temp AS $$
  SELECT m.org_id, m.project_id, m.spec_id, m.owner_id, m.enabled, m.config, m.overrides FROM apitest.mock m WHERE m.token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION apitest.mock_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apitest.mock_lookup(text) TO tb_app;

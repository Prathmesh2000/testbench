-- Identity and access: organisations, people, and who holds which role where.

CREATE TABLE iam.org (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- People are global: one person can belong to several organisations, so this table has no org_id.
-- `subject` is the Keycloak `sub`; it is empty for invited users until their first sign-in.
CREATE TABLE iam.app_user (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject    text UNIQUE,
  email      text NOT NULL UNIQUE CHECK (email = lower(email)),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- project_id NULL means the role applies to every project in the organisation.
CREATE TABLE iam.membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES iam.org (id),
  user_id    uuid NOT NULL REFERENCES iam.app_user (id),
  project_id uuid,
  role       text NOT NULL CHECK (role IN ('org_admin', 'project_admin', 'test_lead', 'tester', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (org_id, user_id, project_id)
);
CREATE INDEX membership_user_idx ON iam.membership (user_id);

ALTER TABLE iam.org ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.membership ENABLE ROW LEVEL SECURITY;

-- A user can always see their own memberships (needed to pick an org before any org context exists),
-- and anyone inside an org can see that org's memberships.
CREATE POLICY membership_visible ON iam.membership FOR SELECT
  USING (org_id = iam.current_org() OR user_id = iam.current_app_user());
CREATE POLICY membership_write ON iam.membership FOR ALL
  USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org());

CREATE POLICY org_visible ON iam.org
  USING (id = iam.current_org()
         OR id IN (SELECT m.org_id FROM iam.membership m WHERE m.user_id = iam.current_app_user()));

-- Colleagues are visible (names on assignees, owners, reviewers); strangers in other orgs are not.
CREATE POLICY app_user_visible ON iam.app_user
  USING (id = iam.current_app_user()
         OR EXISTS (SELECT 1 FROM iam.membership m WHERE m.user_id = app_user.id AND m.org_id = iam.current_org()));

GRANT SELECT ON iam.org, iam.app_user TO tb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON iam.membership TO tb_app;

-- Maps a verified token to a user row, creating it on first sign-in. SECURITY DEFINER because the lookup
-- has to happen before we know who the user is, which is exactly what the RLS policies key on.
-- Invited users are matched by email and get their subject attached, so seeded or invited accounts
-- become usable the first time that person signs in.
CREATE FUNCTION iam.resolve_user(p_subject text, p_email text, p_name text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = iam, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM iam.app_user WHERE subject = p_subject;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  UPDATE iam.app_user SET subject = p_subject
   WHERE email = lower(p_email) AND subject IS NULL
   RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO iam.app_user (subject, email, name) VALUES (p_subject, lower(p_email), p_name)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION iam.resolve_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iam.resolve_user(text, text, text) TO tb_app;

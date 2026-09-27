-- resolve_user used to hit a unique-violation (a 500) when an email was already linked to a different
-- identity-provider subject — for example after an account is deleted and recreated in Keycloak.
-- It now returns NULL in that case, and the API answers with a clear 403 instead.
CREATE OR REPLACE FUNCTION iam.resolve_user(p_subject text, p_email text, p_name text) RETURNS uuid
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

  IF EXISTS (SELECT 1 FROM iam.app_user WHERE email = lower(p_email)) THEN
    RETURN NULL;
  END IF;

  INSERT INTO iam.app_user (subject, email, name) VALUES (p_subject, lower(p_email), p_name)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

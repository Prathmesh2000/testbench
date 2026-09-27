-- Extensions, schemas and the tenant-context helpers every RLS policy uses.

CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA iam;
CREATE SCHEMA repo;
CREATE SCHEMA exec;
CREATE SCHEMA outbox;

GRANT USAGE ON SCHEMA iam, repo, exec, outbox TO tb_app;

-- The API sets these per transaction with set_config(..., true), see packages/platform/src/db/context.ts.
-- nullif() matters: once a connection has run a transaction that set the value, later transactions on the
-- same pooled connection see '' instead of NULL, and ''::uuid would raise instead of matching nothing.
CREATE FUNCTION iam.current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION iam.current_app_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION iam.current_org(), iam.current_app_user() TO tb_app;

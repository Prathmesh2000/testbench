-- API Studio phase A2 (docs/api-testing-plan.md §9–§11): spec quality rules a project switched off,
-- enrichment answers (the overlay on a spec), and generated tests waiting for review.

-- A quality rule a project switched off, and why. Rules are on unless listed here.
CREATE TABLE apitest.lint_setting (
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo.project (id),
  rule       text NOT NULL CHECK (length(rule) BETWEEN 1 AND 60),
  enabled    boolean NOT NULL,
  reason     text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, rule)
);

-- One answered (or skipped, or assigned) enrichment question per spec. Questions themselves are
-- found from the spec on read; their ids are stable hashes of kind and pointer, so an answer outlives
-- the version it was given on. `patches` is what the answer adds to the spec, as JSON-pointer changes.
CREATE TABLE apitest.enrichment_answer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  spec_id     uuid NOT NULL REFERENCES apitest.spec (id) ON DELETE CASCADE,
  question_id text NOT NULL CHECK (length(question_id) BETWEEN 8 AND 40),
  kind        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('open', 'answered', 'skipped')),
  answer      jsonb,
  patches     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(patches) = 'array'),
  -- 'ai' when the tester accepted an AI draft: it is still their answer, but the source is kept.
  source      text CHECK (source IS NULL OR source IN ('user', 'ai')),
  assigned_to uuid,
  answered_by uuid,
  answered_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (spec_id, question_id)
);

-- Tests generated from a spec, one row per generated id. Regenerating keeps rows a tester decided on
-- and adds new ones as pending; `variation_id` is the variation an accepted test became.
CREATE TABLE apitest.generated_test (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  spec_id      uuid NOT NULL REFERENCES apitest.spec (id) ON DELETE CASCADE,
  gen_id       text NOT NULL CHECK (length(gen_id) BETWEEN 8 AND 40),
  version      integer NOT NULL,
  operation    text NOT NULL,
  kind         text NOT NULL,
  name         text NOT NULL,
  -- { overrides, expect, why, pointer }.
  payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  request_id   uuid REFERENCES apitest.node (id) ON DELETE SET NULL,
  variation_id uuid REFERENCES apitest.variation (id) ON DELETE SET NULL,
  decided_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (spec_id, gen_id)
);
CREATE INDEX generated_test_spec_idx ON apitest.generated_test (org_id, spec_id, status);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['apitest.lint_setting', 'apitest.enrichment_answer', 'apitest.generated_test'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant ON %s USING (org_id = iam.current_org()) WITH CHECK (org_id = iam.current_org())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON apitest.lint_setting, apitest.enrichment_answer, apitest.generated_test TO tb_app;

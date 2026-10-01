-- The meta layer for intent-built tests (testing-studio-plan §3.3). Additive: both columns have a
-- safe default, so code that does not know them keeps working.

-- { prerequisites, intent, goal } in the tester's words. Null for a test not built from an intent.
-- On the test, not the version: it says what the test is for, which edits to its steps do not change.
ALTER TABLE studio.test ADD COLUMN intent jsonb
  CHECK (intent IS NULL OR (jsonb_typeof(intent) = 'object' AND intent ? 'intent' AND intent ? 'goal'));

-- { purpose, leaves, preconditions, tags, inputKinds, origin }: what a segment is for, what state it
-- leaves the app in (how a later test knows it fits) and what each input holds. See ComponentMeta.
ALTER TABLE studio.component ADD COLUMN meta jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object');

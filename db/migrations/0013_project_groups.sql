-- Many projects per organisation: an optional group (a product line or team, e.g. "Payments") to
-- organise them, a description, and archiving instead of deletion so history stays intact.
ALTER TABLE repo.project
  ADD COLUMN group_name  text CHECK (group_name IS NULL OR length(group_name) BETWEEN 1 AND 60),
  ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  ADD COLUMN archived    boolean NOT NULL DEFAULT false,
  ADD COLUMN created_by  uuid;

CREATE INDEX project_group_idx ON repo.project (org_id, group_name, key);

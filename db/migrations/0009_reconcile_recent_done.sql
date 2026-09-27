-- The reconciler only looked at defects that were not done, so a reopen in Jira whose webhook was
-- lost left our copy "Done" forever. Recently finished defects are now checked too: reopens happen
-- within days of a fix, and two weeks bounds the extra Jira queries.
CREATE OR REPLACE FUNCTION defect.projects_to_reconcile() RETURNS TABLE (org_id uuid, project_id uuid)
  LANGUAGE sql SECURITY DEFINER STABLE SET search_path = defect, pg_temp AS $$
  SELECT DISTINCT d.org_id, d.project_id FROM defect.defect d
   WHERE d.status_category <> 'done' OR d.synced_at > now() - interval '14 days'
$$;

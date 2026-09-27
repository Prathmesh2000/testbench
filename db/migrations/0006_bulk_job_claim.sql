-- Lets the bulk-edit worker find the next job across all organisations. The worker has no tenant
-- context until it knows which job it is running, and RLS would hide every job from it, so this one
-- narrow function runs as the owner and returns only what the worker needs to switch into that tenant.
--
-- A job counts as abandoned when it has been "running" without progress for two minutes (its worker
-- crashed); it is then handed to the next worker, which resumes from the job's cursor.
CREATE FUNCTION repo.claim_bulk_job() RETURNS TABLE (id uuid, org_id uuid, created_by uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = repo, pg_temp AS $$
  UPDATE repo.bulk_job j
     SET status = 'running', updated_at = now()
   WHERE j.id = (
     SELECT q.id FROM repo.bulk_job q
      WHERE q.status = 'queued' OR (q.status = 'running' AND q.updated_at < now() - interval '2 minutes')
      ORDER BY q.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING j.id, j.org_id, j.created_by
$$;
REVOKE ALL ON FUNCTION repo.claim_bulk_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION repo.claim_bulk_job() TO tb_app;

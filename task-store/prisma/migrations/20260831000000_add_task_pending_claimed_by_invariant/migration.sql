-- Defense-in-depth: enforce at the database layer that a Task can never be
-- persisted with status='pending' and a non-null claimedBy. This is the
-- invariant a prior bug (AGH-3.4) violated. An app-level guard already
-- tightened TaskService.claim()'s WHERE clause (PR #2528, commit 0c2f7a7c),
-- but that does not prevent every write path (e.g. a manual admin PATCH, or
-- a different future code path) from writing the invalid shape. This
-- CHECK constraint is the last line of defense.

-- Live-data safety check: verify at migration-execution time (not just at
-- planning time) that no existing rows already violate the invariant, so the
-- ALTER TABLE below fails with a clear, actionable message instead of a bare
-- Postgres constraint-violation error if the data were dirty.
DO $$
DECLARE
  violation_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO violation_count
  FROM "Task"
  WHERE "status" = 'pending' AND "claimedBy" IS NOT NULL;

  IF violation_count > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: % Task row(s) violate the pending/claimedBy invariant (status=pending with non-null claimedBy). Resolve these rows before applying this migration.',
      violation_count;
  END IF;
END $$;

-- CreateCheckConstraint
ALTER TABLE "Task" ADD CONSTRAINT "task_pending_claimed_by_invariant"
  CHECK (("status" = 'pending' AND "claimedBy" IS NULL) OR "status" != 'pending');

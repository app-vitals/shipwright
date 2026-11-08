-- MPD-3.5: drop the `deploying` task status, `Task.deployingAt`, the `deploy`
-- PR phase and `PullRequest.readyForDeployAt`. MPD-1.1 added the
-- replacements (`released`, `merge`, `readyForMergeAt`) and MPD-3.1–3.4
-- removed every producer and consumer, so nothing writes these any more.
--
-- Postgres cannot DROP an enum value, so both enums are recreated. Every row
-- that still carries a dropped value is migrated first, inside the same
-- transaction, so the `::text::"<Enum>_new"` casts below cannot fail.

BEGIN;

-- ─── Data migration ────────────────────────────────────────────────────────────
-- A task stranded mid-deploy has, by definition, already merged.
UPDATE "Task" SET "status" = 'merged' WHERE "status" = 'deploying';

-- Deploy-phase claims belong to a phase that no longer exists: clear the phase
-- and the claim so the merge phase can pick the PR up again.
UPDATE "PullRequest"
SET "phase" = NULL, "claimedBy" = NULL, "claimedAt" = NULL, "heartbeatAt" = NULL
WHERE "phase" = 'deploy';

-- Keep FIFO aging: carry readyForDeployAt into readyForMergeAt where the merge
-- phase has not stamped its own value yet.
UPDATE "PullRequest"
SET "readyForMergeAt" = "readyForDeployAt"
WHERE "readyForMergeAt" IS NULL AND "readyForDeployAt" IS NOT NULL;

-- ─── Recreate PrPhase without `deploy` ─────────────────────────────────────────
CREATE TYPE "PrPhase_new" AS ENUM ('review', 'patch', 'merge');
ALTER TABLE "PullRequest" ALTER COLUMN "phase" TYPE "PrPhase_new" USING ("phase"::text::"PrPhase_new");
ALTER TYPE "PrPhase" RENAME TO "PrPhase_old";
ALTER TYPE "PrPhase_new" RENAME TO "PrPhase";
DROP TYPE "PrPhase_old";

-- ─── Recreate TaskStatus without `deploying` ───────────────────────────────────
-- The pending/claimedBy CHECK constraint compares "status" to an enum literal,
-- so it is dropped around the column type change and re-added unchanged.
ALTER TABLE "Task" DROP CONSTRAINT "task_pending_claimed_by_invariant";
CREATE TYPE "TaskStatus_new" AS ENUM ('pending', 'in_progress', 'pr_open', 'approved', 'merged', 'done', 'deployed', 'released', 'blocked', 'cancelled');
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus_new" USING ("status"::text::"TaskStatus_new");
ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
DROP TYPE "TaskStatus_old";
ALTER TABLE "Task" ADD CONSTRAINT "task_pending_claimed_by_invariant"
  CHECK (("status" = 'pending' AND "claimedBy" IS NULL) OR "status" != 'pending');

-- ─── Drop the superseded columns ───────────────────────────────────────────────
-- After the readyForMergeAt backfill above, which reads readyForDeployAt.
ALTER TABLE "PullRequest" DROP COLUMN "readyForDeployAt";
ALTER TABLE "Task" DROP COLUMN "deployingAt";

COMMIT;

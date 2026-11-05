-- MPD-1.1: additive only — new `released` task status + `releasedAt`, new
-- `merge` PR phase + `readyForMergeAt`. Nothing is renamed or dropped;
-- `deploying`/`deployingAt`/PrPhase.deploy/readyForDeployAt stay (MPD-3.5).

-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'released';

-- AlterEnum
ALTER TYPE "PrPhase" ADD VALUE 'merge';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "releasedAt" TEXT;

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "readyForMergeAt" TEXT;

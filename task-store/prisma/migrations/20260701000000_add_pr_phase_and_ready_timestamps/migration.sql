-- CreateEnum: PrPhase
CREATE TYPE "PrPhase" AS ENUM ('review', 'patch', 'deploy');

-- AlterTable: add phase and readyFor*At columns to PullRequest
ALTER TABLE "PullRequest" ADD COLUMN "phase"            "PrPhase";
ALTER TABLE "PullRequest" ADD COLUMN "readyForReviewAt"  TEXT;
ALTER TABLE "PullRequest" ADD COLUMN "readyForPatchAt"   TEXT;
ALTER TABLE "PullRequest" ADD COLUMN "readyForDeployAt"  TEXT;

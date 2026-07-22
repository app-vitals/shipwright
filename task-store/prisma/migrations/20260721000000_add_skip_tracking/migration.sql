-- AlterTable: add skipCount/lastSkippedAt to Task
ALTER TABLE "Task" ADD COLUMN "skipCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Task" ADD COLUMN "lastSkippedAt" TEXT;

-- AlterTable: add skipCount/lastSkippedAt to PullRequest
ALTER TABLE "PullRequest" ADD COLUMN "skipCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PullRequest" ADD COLUMN "lastSkippedAt" TEXT;

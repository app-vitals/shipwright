-- AlterTable: add hitl/hitlNotifiedAt/blockedReason to PullRequest
ALTER TABLE "PullRequest" ADD COLUMN "hitl" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PullRequest" ADD COLUMN "hitlNotifiedAt" TEXT;
ALTER TABLE "PullRequest" ADD COLUMN "blockedReason" TEXT;

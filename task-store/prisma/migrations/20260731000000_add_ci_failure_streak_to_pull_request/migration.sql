-- AlterTable: add CI-failure streak tracking to PullRequest
-- Additive, nullable/defaulted columns — no data loss; existing rows get
-- lastCiFailureSignature=NULL and consecutiveCiFailureCount=0.
ALTER TABLE "PullRequest" ADD COLUMN "lastCiFailureSignature" TEXT;
ALTER TABLE "PullRequest" ADD COLUMN "consecutiveCiFailureCount" INTEGER NOT NULL DEFAULT 0;

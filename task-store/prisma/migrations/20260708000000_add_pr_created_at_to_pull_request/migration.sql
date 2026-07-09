-- AlterTable: add prCreatedAt (GitHub PR creation timestamp) to PullRequest
ALTER TABLE "PullRequest" ADD COLUMN "prCreatedAt" TEXT;

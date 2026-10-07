-- PSL-3.1: record block-time head SHA/review and preserved auto-block history.
-- All columns nullable; existing rows are unaffected.

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN "blockedHeadSha" TEXT,
ADD COLUMN "blockedReviewId" TEXT,
ADD COLUMN "blockedAt" TEXT,
ADD COLUMN "lastAutoBlockReason" TEXT,
ADD COLUMN "lastAutoBlockedAt" TEXT;

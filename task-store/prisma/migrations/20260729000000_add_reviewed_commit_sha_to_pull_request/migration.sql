-- AlterTable: add reviewedCommitSha to PullRequest
-- Additive, nullable column — no data loss, defaults to NULL for existing rows.
-- This field is the review pipeline's exclusive commit-tracking field, separate
-- from the shared commitSha field written by claim()/patch()/deploy for their
-- own multi-phase bookkeeping.
ALTER TABLE "PullRequest" ADD COLUMN "reviewedCommitSha" TEXT;

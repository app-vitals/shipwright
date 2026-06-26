-- AlterTable: add reviewCycles to PullRequest
ALTER TABLE "PullRequest" ADD COLUMN "reviewCycles" INTEGER NOT NULL DEFAULT 0;

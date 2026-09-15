-- TKD-1.1: introduce TaskKind, the enum that supersedes the boolean
-- autonomousPlanSession flag. Purely additive — autonomousPlanSession is kept
-- (column, API field, and ?autonomousPlanSession= filter) for the transition
-- window, and the task-store normalizes between the two on every write.

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('dev', 'prd');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "kind" "TaskKind" NOT NULL DEFAULT 'dev';

-- ─── Data migration ────────────────────────────────────────────────────────────
-- Every task previously flagged for an autonomous plan session becomes kind='prd'
-- so ready.ts's new kind-based exclusion covers exactly the rows its old
-- autonomousPlanSession-based exclusion did. Everything else keeps the 'dev'
-- default, which is what a NULL/false flag already meant.
UPDATE "Task" SET "kind" = 'prd' WHERE "autonomousPlanSession" = true;

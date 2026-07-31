-- Split the single hitl signal into two distinct signals:
--   Task.requiresHumanApproval — Type B merge-approval-gate classification
--   PullRequest.blocked        — a PR blocked in the pipeline
-- and drop the dead Task.hitlNotifiedAt field plus the PullRequest hitl fields.

-- AlterTable: add requiresHumanApproval to Task
ALTER TABLE "Task" ADD COLUMN "requiresHumanApproval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: add blocked to PullRequest
ALTER TABLE "PullRequest" ADD COLUMN "blocked" BOOLEAN NOT NULL DEFAULT false;

-- ─── Data migration ────────────────────────────────────────────────────────────
-- Clear hitl on records that were pipeline-escalation/spin-detection, not genuine
-- Type A infra tasks -- plan-session's Type A classification never sets blockedReason.
UPDATE "Task" SET "hitl" = false WHERE "hitl" = true AND "blockedReason" IS NOT NULL;

-- Move any still-open ones onto the new blocked-status signal.
UPDATE "Task" SET "status" = 'blocked'
WHERE "hitl" = false AND "blockedReason" IS NOT NULL
  AND "status" NOT IN ('merged','done','deploying','deployed','cancelled');

-- Carry forward only still-open PRs (closed/merged data loss is accepted).
UPDATE "PullRequest" SET "blocked" = true WHERE "hitl" = true AND "state" = 'open';

-- ─── Drop dead / superseded columns ────────────────────────────────────────────
-- DROP after the UPDATEs above, which read/write the hitl column being dropped.
ALTER TABLE "Task" DROP COLUMN "hitlNotifiedAt";
ALTER TABLE "PullRequest" DROP COLUMN "hitl";
ALTER TABLE "PullRequest" DROP COLUMN "hitlNotifiedAt";

-- Migration: drop the legacy AgentCronRun.phase string column.
-- LPC-3.1: phaseId (FK to AgentCronJob.id, added in LPC-1.1) is now the sole
-- phase-attribution field. The writer (loop-orchestrator) and reader
-- (cron-logs admin UI) have both been switched over to phaseId in the same
-- PR — atomic removal, no dual-write/dual-read period, per the plugin
-- constitution's breaking-change guidance for in-repo-only consumers.

ALTER TABLE "AgentCronRun" DROP COLUMN "phase";

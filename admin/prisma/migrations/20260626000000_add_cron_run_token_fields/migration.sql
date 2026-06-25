-- AddColumns: token tracking fields to AgentCronRun.
-- These fields allow the harness to record LLM token usage and cost per cron invocation.
-- All columns are nullable so existing rows are unaffected.

ALTER TABLE "AgentCronRun" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "AgentCronRun" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "AgentCronRun" ADD COLUMN "cacheReadTokens" INTEGER;
ALTER TABLE "AgentCronRun" ADD COLUMN "cacheCreationTokens" INTEGER;
ALTER TABLE "AgentCronRun" ADD COLUMN "costUsd" DOUBLE PRECISION;
ALTER TABLE "AgentCronRun" ADD COLUMN "model" TEXT;

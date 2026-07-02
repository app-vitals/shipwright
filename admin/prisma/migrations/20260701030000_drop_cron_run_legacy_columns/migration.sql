-- Migration: drop legacy model and costUsd columns from AgentCronRun.
-- MA-5: all new runs use AgentCronRunModelBreakdown; the fallback path is removed.

ALTER TABLE "AgentCronRun" DROP COLUMN IF EXISTS "model";
ALTER TABLE "AgentCronRun" DROP COLUMN IF EXISTS "costUsd";

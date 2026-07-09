-- AlterTable: add nullable phase column to AgentCronRun
-- WL-3.4: the unified loop (shipwright-loop) runs many distinct one-shot
-- invocations per outer tick, each serving a different pipeline phase
-- (dev-task/review/patch/deploy), all reported under the single
-- shipwright-loop cronId. phase records which pipeline phase an individual
-- run served. Legacy five-job crons leave this column null (cronId itself
-- was the phase signal under that model).
ALTER TABLE "AgentCronRun" ADD COLUMN "phase" TEXT;

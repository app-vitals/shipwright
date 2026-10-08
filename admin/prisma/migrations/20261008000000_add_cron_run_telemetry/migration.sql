-- Run telemetry for the prompt-audit patrol (all additive, nullable):
--   * AgentCronRun gains the first-turn context baseline (the measured
--     always-loaded context per run), turn/tool-call counts, and the
--     always-loaded-context fingerprint + versions that group runs by what
--     the model was given.
--   * AgentCronRunSkillUsage holds per-skill / per-subagent token
--     attribution rows, one per [cronRunId, kind, name].
-- Older agent builds simply never set these; nothing is backfilled.

-- AlterTable
ALTER TABLE "AgentCronRun"
  ADD COLUMN "baselineModel" TEXT,
  ADD COLUMN "baselineContextTokens" INTEGER,
  ADD COLUMN "baselineInputTokens" INTEGER,
  ADD COLUMN "baselineCacheCreationTokens" INTEGER,
  ADD COLUMN "baselineCacheReadTokens" INTEGER,
  ADD COLUMN "turns" INTEGER,
  ADD COLUMN "toolCalls" INTEGER,
  ADD COLUMN "contextFingerprint" TEXT,
  ADD COLUMN "pluginVersion" TEXT,
  ADD COLUMN "claudeCodeVersion" TEXT;

-- CreateIndex
CREATE INDEX "AgentCronRun_contextFingerprint_idx" ON "AgentCronRun"("contextFingerprint");

-- CreateTable
CREATE TABLE "AgentCronRunSkillUsage" (
    "id" TEXT NOT NULL,
    "cronRunId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "invocations" INTEGER NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "invokeContextDelta" INTEGER,

    CONSTRAINT "AgentCronRunSkillUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCronRunSkillUsage_cronRunId_kind_name_key" ON "AgentCronRunSkillUsage"("cronRunId", "kind", "name");

-- CreateIndex
CREATE INDEX "AgentCronRunSkillUsage_kind_name_idx" ON "AgentCronRunSkillUsage"("kind", "name");

-- AddForeignKey
ALTER TABLE "AgentCronRunSkillUsage" ADD CONSTRAINT "AgentCronRunSkillUsage_cronRunId_fkey" FOREIGN KEY ("cronRunId") REFERENCES "AgentCronRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

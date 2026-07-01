-- AddTable: AgentCronRunModelBreakdown
-- Stores per-model token breakdown for each cron run. Populated when sub-agents
-- use different models in a single run. The unique constraint on (cronRunId, model)
-- allows upsert semantics.

CREATE TABLE "AgentCronRunModelBreakdown" (
    "id" TEXT NOT NULL,
    "cronRunId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AgentCronRunModelBreakdown_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentCronRunModelBreakdown_cronRunId_model_key" ON "AgentCronRunModelBreakdown"("cronRunId", "model");

-- AddForeignKey
ALTER TABLE "AgentCronRunModelBreakdown" ADD CONSTRAINT "AgentCronRunModelBreakdown_cronRunId_fkey" FOREIGN KEY ("cronRunId") REFERENCES "AgentCronRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

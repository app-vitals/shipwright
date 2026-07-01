-- DropTable (old per-agent daily rollup — no backward compat needed)
DROP TABLE IF EXISTS "AgentChatTokenUsageDaily";

-- CreateTable (new per-model daily rollup)
CREATE TABLE "AgentChatTokenUsageDailyByModel" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentChatTokenUsageDailyByModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentChatTokenUsageDailyByModel_agentId_date_model_key" ON "AgentChatTokenUsageDailyByModel"("agentId", "date", "model");

-- AddForeignKey
ALTER TABLE "AgentChatTokenUsageDailyByModel" ADD CONSTRAINT "AgentChatTokenUsageDailyByModel_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

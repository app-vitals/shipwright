-- CreateTable: AgentWorkQueueSnapshot — one row per agent, holding the
-- agent's most recently pushed work-queue snapshot. agentId is unique so
-- POST /agents/:id/work-queue can upsert a single row per agent.

-- CreateTable
CREATE TABLE "AgentWorkQueueSnapshot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentWorkQueueSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkQueueSnapshot_agentId_key" ON "AgentWorkQueueSnapshot"("agentId");

-- AddForeignKey
ALTER TABLE "AgentWorkQueueSnapshot" ADD CONSTRAINT "AgentWorkQueueSnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

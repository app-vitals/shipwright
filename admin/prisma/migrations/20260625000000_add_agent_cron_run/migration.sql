-- CreateTable: AgentCronRun — execution history for AgentCronJob firings.
-- agentId is denormalized for efficient agent-level history queries.

CREATE TABLE "AgentCronRun" (
    "id" TEXT NOT NULL,
    "cronId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skipReason" TEXT,
    "outcome" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentCronRun_cronId_idx" ON "AgentCronRun"("cronId");

-- CreateIndex
CREATE INDEX "AgentCronRun_agentId_startedAt_idx" ON "AgentCronRun"("agentId", "startedAt");

-- AddForeignKey
ALTER TABLE "AgentCronRun" ADD CONSTRAINT "AgentCronRun_cronId_fkey" FOREIGN KEY ("cronId") REFERENCES "AgentCronJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

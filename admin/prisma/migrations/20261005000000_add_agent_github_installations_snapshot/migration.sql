-- CreateTable: AgentGitHubInstallationsSnapshot — one row per agent, holding
-- the agent's most recently reported GitHub App installations. agentId is
-- unique so PUT /agents/:id/github-installations can upsert a single row.
-- Additive only.

-- CreateTable
CREATE TABLE "AgentGitHubInstallationsSnapshot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "installations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentGitHubInstallationsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentGitHubInstallationsSnapshot_agentId_key" ON "AgentGitHubInstallationsSnapshot"("agentId");

-- AddForeignKey
ALTER TABLE "AgentGitHubInstallationsSnapshot" ADD CONSTRAINT "AgentGitHubInstallationsSnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

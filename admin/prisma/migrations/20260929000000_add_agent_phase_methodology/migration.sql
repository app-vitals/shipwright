-- PMC-1.1: per-phase subagent-type override table. Additive; no changes to
-- existing tables. `phase` is constrained to the six-value pipeline-phase
-- enum (prd | plan-session | review | patch | deploy | dev-task) at the
-- service/route layer (Zod), not here.

-- CreateTable
CREATE TABLE "AgentPhaseMethodology" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "subagentType" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPhaseMethodology_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentPhaseMethodology_agentId_phase_key" ON "AgentPhaseMethodology"("agentId", "phase");

-- AddForeignKey
ALTER TABLE "AgentPhaseMethodology" ADD CONSTRAINT "AgentPhaseMethodology_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

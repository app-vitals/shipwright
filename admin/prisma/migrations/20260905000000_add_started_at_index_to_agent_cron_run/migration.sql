-- AAV-1.1: add a standalone index on AgentCronRun.startedAt.
--
-- The existing composite index on (agentId, startedAt) is optimized for
-- single-agent lookups (listForAgent/list), not a global "startedAt desc"
-- sort across a large `agentId IN (...)` set (listAcrossAgents). As the
-- agent fleet grows from <10 today toward ~250 within 3-6 months, a
-- fleet-wide cross-agent listing needs its own index to avoid a full table
-- scan/sort. Purely additive — no column changes.

-- CreateIndex
CREATE INDEX "AgentCronRun_startedAt_idx" ON "AgentCronRun"("startedAt");

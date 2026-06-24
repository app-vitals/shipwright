-- Add agentId to TaskToken.
-- null = admin token (unrestricted); set = agent token scoped to that agent ID.
ALTER TABLE "TaskToken" ADD COLUMN "agentId" TEXT;

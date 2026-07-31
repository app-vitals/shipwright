-- Add nullable sessionId column to AgentCronRun
ALTER TABLE "AgentCronRun" ADD COLUMN "sessionId" TEXT;

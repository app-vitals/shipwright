-- AddForeignKey
ALTER TABLE "AgentChatTokenUsageDaily" ADD CONSTRAINT "AgentChatTokenUsageDaily_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

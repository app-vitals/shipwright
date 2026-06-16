-- CreateTable
CREATE TABLE "AgentMember" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMember_email_idx" ON "AgentMember"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMember_agentId_email_key" ON "AgentMember"("agentId", "email");

-- AddForeignKey
ALTER TABLE "AgentMember" ADD CONSTRAINT "AgentMember_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

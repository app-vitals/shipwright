-- PAI-1.1: owner and Anthropic identity columns on Agent (additive, nullable).
ALTER TABLE "Agent" ADD COLUMN "ownerEmail" TEXT;
ALTER TABLE "Agent" ADD COLUMN "anthropicIdentityName" TEXT;
ALTER TABLE "Agent" ADD COLUMN "anthropicServiceAccountId" TEXT;
ALTER TABLE "Agent" ADD COLUMN "anthropicFederationRuleId" TEXT;
ALTER TABLE "Agent" ADD COLUMN "k8sServiceAccountName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_anthropicIdentityName_key" ON "Agent"("anthropicIdentityName");

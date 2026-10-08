-- SSP-1.2: Account, AccountMember, AccountInvite + nullable Agent.accountId.
-- Additive only: existing Agent rows keep accountId = NULL.
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxAgents" INTEGER NOT NULL DEFAULT 0,
    "plan" TEXT,
    "trialExpiresAt" TIMESTAMP(3),
    "trialExpiryWarnedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountMember" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountInvite" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "AccountInvite_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Agent" ADD COLUMN "accountId" TEXT;

CREATE UNIQUE INDEX "AccountMember_email_key" ON "AccountMember"("email");
CREATE UNIQUE INDEX "AccountMember_accountId_email_key" ON "AccountMember"("accountId", "email");
CREATE INDEX "AccountInvite_email_idx" ON "AccountInvite"("email");
CREATE UNIQUE INDEX "AccountInvite_accountId_email_key" ON "AccountInvite"("accountId", "email");
CREATE INDEX "Agent_accountId_idx" ON "Agent"("accountId");

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountMember" ADD CONSTRAINT "AccountMember_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountInvite" ADD CONSTRAINT "AccountInvite_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

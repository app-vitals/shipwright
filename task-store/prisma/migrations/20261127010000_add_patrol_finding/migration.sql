-- PCR-1.2: additive only — new PatrolFinding table, no changes to existing tables.

-- CreateTable
CREATE TABLE "PatrolFinding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "cronId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "history" JSONB NOT NULL,
    "detail" JSONB,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatrolFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatrolFinding_accountId_cronId_repo_status_idx" ON "PatrolFinding"("accountId", "cronId", "repo", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PatrolFinding_accountId_cronId_repo_fingerprint_key" ON "PatrolFinding"("accountId", "cronId", "repo", "fingerprint");

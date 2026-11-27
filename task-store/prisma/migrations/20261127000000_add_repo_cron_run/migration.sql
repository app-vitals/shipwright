-- PCR-1.1: additive only — new append-only RepoCronRun table, no changes to existing tables.

-- CreateTable
CREATE TABLE "RepoCronRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "cronId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "taskId" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "commitSha" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "machineState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoCronRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepoCronRun_accountId_cronId_repo_finishedAt_idx" ON "RepoCronRun"("accountId", "cronId", "repo", "finishedAt");

-- RDY-1.2: additive only — new ReadinessSnapshot table, no changes to existing tables.

-- CreateTable
CREATE TABLE "ReadinessSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "repo" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "passing" INTEGER NOT NULL,
    "failing" INTEGER NOT NULL,
    "checks" JSONB NOT NULL,
    "catalogueVersion" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadinessSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_repo_measuredAt_idx" ON "ReadinessSnapshot"("repo", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReadinessSnapshot_accountId_repo_commitSha_key" ON "ReadinessSnapshot"("accountId", "repo", "commitSha");

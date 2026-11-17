-- CVT-2.1: additive only — new CoverageSnapshot table, no changes to existing tables.

-- CreateTable
CREATE TABLE "CoverageSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "repo" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "linesCovered" INTEGER NOT NULL,
    "linesTotal" INTEGER NOT NULL,
    "linesPct" DOUBLE PRECISION NOT NULL,
    "branchesCovered" INTEGER,
    "branchesTotal" INTEGER,
    "branchesPct" DOUBLE PRECISION,
    "functionsCovered" INTEGER,
    "functionsTotal" INTEGER,
    "functionsPct" DOUBLE PRECISION,
    "tool" TEXT NOT NULL,
    "runUrl" TEXT,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoverageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoverageSnapshot_repo_measuredAt_idx" ON "CoverageSnapshot"("repo", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoverageSnapshot_accountId_repo_commitSha_key" ON "CoverageSnapshot"("accountId", "repo", "commitSha");

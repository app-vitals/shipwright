-- CreateEnum
CREATE TYPE "PrState" AS ENUM ('open', 'merged', 'closed');

-- CreateEnum
CREATE TYPE "PrReviewState" AS ENUM ('pending', 'in_progress', 'posted', 'patching', 'approved');

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "taskId" TEXT,
    "staged" BOOLEAN NOT NULL DEFAULT false,
    "state" "PrState" NOT NULL DEFAULT 'open',
    "reviewState" "PrReviewState" NOT NULL DEFAULT 'pending',
    "commitSha" TEXT,
    "patchCycles" INTEGER NOT NULL DEFAULT 0,
    "agentId" TEXT,
    "reviewedAt" TEXT,
    "patchedAt" TEXT,
    "mergedAt" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TEXT,
    "heartbeatAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PullRequest_taskId_idx" ON "PullRequest"("taskId");

-- CreateIndex
CREATE INDEX "PullRequest_state_idx" ON "PullRequest"("state");

-- CreateIndex
CREATE INDEX "PullRequest_reviewState_idx" ON "PullRequest"("reviewState");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repo_prNumber_key" ON "PullRequest"("repo", "prNumber");

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'in_progress', 'pr_open', 'approved', 'merged', 'done', 'deploying', 'deployed', 'blocked', 'cancelled');

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "source" TEXT,
    "session" TEXT,
    "repo" TEXT,
    "description" TEXT,
    "acceptanceCriteria" TEXT[],
    "layer" TEXT,
    "branch" TEXT,
    "dependencies" TEXT[],
    "pr" INTEGER,
    "hours" DOUBLE PRECISION,
    "addedAt" TEXT,
    "startedAt" TEXT,
    "prCreatedAt" TEXT,
    "mergedAt" TEXT,
    "blockedAt" TEXT,
    "blockedReason" TEXT,
    "note" TEXT,
    "type" TEXT,
    "priority" TEXT,
    "cancelledAt" TEXT,
    "completedAt" TEXT,
    "deployingAt" TEXT,
    "ciFixAttempts" INTEGER,
    "mergeCommit" TEXT,
    "prUrl" TEXT,
    "assignee" TEXT,
    "issue" TEXT,
    "model" TEXT,
    "complexity" INTEGER,
    "hitl" BOOLEAN,
    "hitlNotifiedAt" TEXT,
    "claimedBy" TEXT,
    "agentHint" TEXT,
    "claimedAt" TEXT,
    "heartbeatAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TaskToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_session_idx" ON "Task"("session");

-- CreateIndex
CREATE INDEX "Task_assignee_idx" ON "Task"("assignee");

-- CreateIndex
CREATE INDEX "Task_claimedBy_idx" ON "Task"("claimedBy");

-- CreateIndex
CREATE UNIQUE INDEX "TaskToken_token_key" ON "TaskToken"("token");


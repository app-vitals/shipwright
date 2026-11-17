-- PLU-2.1: additive only — new PlanDocument table (+ its two enums) and
-- nullable, default-free columns on Session and Task. Existing rows read NULL
-- for every new column. No renames, drops, defaults or constraints on
-- existing data. The document-id columns on Task are plain strings, not FKs.

-- CreateEnum
CREATE TYPE "PlanDocumentKind" AS ENUM ('spec', 'plan');

-- CreateEnum
CREATE TYPE "PlanDocumentState" AS ENUM ('draft', 'pr_open', 'merged', 'abandoned');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "declaredRepos" TEXT[],
ADD COLUMN     "homeRepo" TEXT,
ADD COLUMN     "owner" TEXT,
ADD COLUMN     "planningLockExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planningLockHolder" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "originKind" TEXT,
ADD COLUMN     "originRef" TEXT,
ADD COLUMN     "owner" TEXT,
ADD COLUMN     "planDocumentId" TEXT,
ADD COLUMN     "specDocumentId" TEXT;

-- CreateTable
CREATE TABLE "PlanDocument" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "session" TEXT NOT NULL,
    "kind" "PlanDocumentKind" NOT NULL,
    "number" INTEGER NOT NULL,
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT,
    "owner" TEXT,
    "repos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prUrl" TEXT,
    "state" "PlanDocumentState" NOT NULL DEFAULT 'draft',
    "commitSha" TEXT,
    "plannedAt" TIMESTAMP(3),
    "originTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanDocument_accountId_session_kind_number_key" ON "PlanDocument"("accountId", "session", "kind", "number");

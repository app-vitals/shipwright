-- CreateEnum
CREATE TYPE "VerificationCheckStatus" AS ENUM ('ran_passed', 'ran_failed', 'skipped', 'timed_out');

-- CreateEnum
CREATE TYPE "VerificationCheckReasonCategory" AS ENUM ('check_timeout', 'install_timeout', 'resource_limit', 'missing_tool', 'missing_secret', 'missing_dependency', 'not_configured', 'learned_skip');

-- CreateTable
CREATE TABLE "VerificationCheck" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "prRecordId" TEXT,
    "repo" TEXT NOT NULL,
    "checkName" TEXT NOT NULL,
    "status" "VerificationCheckStatus" NOT NULL,
    "reasonCategory" "VerificationCheckReasonCategory",
    "learnedFromCategory" "VerificationCheckReasonCategory",
    "durationMs" INTEGER,
    "at" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationCheck_taskId_at_idx" ON "VerificationCheck"("taskId", "at");

-- CreateIndex
CREATE INDEX "VerificationCheck_prRecordId_at_idx" ON "VerificationCheck"("prRecordId", "at");

-- CreateIndex
CREATE INDEX "VerificationCheck_repo_checkName_idx" ON "VerificationCheck"("repo", "checkName");

-- AddForeignKey
ALTER TABLE "VerificationCheck" ADD CONSTRAINT "VerificationCheck_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCheck" ADD CONSTRAINT "VerificationCheck_prRecordId_fkey" FOREIGN KEY ("prRecordId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

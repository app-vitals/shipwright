-- SSP-6.1: add accountId (constant default 'default') to the four tenant-scoped
-- tables plus NEW unique keys alongside the old ones. Additive only: no column
-- dropped, the old repo+prNumber unique and the Session slug primary key stay
-- until SSP-6.4 / SSP-6.9. Postgres fills a constant default on existing rows
-- without a table rewrite, so every existing row becomes 'default'.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "accountId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "PullRequest" ADD COLUMN "accountId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Session" ADD COLUMN "accountId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "VerificationCheck" ADD COLUMN "accountId" TEXT NOT NULL DEFAULT 'default';

-- CreateIndex
CREATE INDEX "Task_accountId_idx" ON "Task"("accountId");
CREATE INDEX "PullRequest_accountId_idx" ON "PullRequest"("accountId");
CREATE INDEX "Session_accountId_idx" ON "Session"("accountId");
CREATE INDEX "VerificationCheck_accountId_idx" ON "VerificationCheck"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_accountId_repo_prNumber_key" ON "PullRequest"("accountId", "repo", "prNumber");
CREATE UNIQUE INDEX "Session_accountId_slug_key" ON "Session"("accountId", "slug");

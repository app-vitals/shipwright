-- CreateEnum
CREATE TYPE "PrOrigin" AS ENUM ('shipwright', 'ci', 'dependency_bot', 'human', 'unknown');

-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "authorLogin" TEXT,
ADD COLUMN     "headRef" TEXT,
ADD COLUMN     "origin" "PrOrigin",
ADD COLUMN     "title" TEXT;

-- CreateIndex
CREATE INDEX "PullRequest_origin_idx" ON "PullRequest"("origin");

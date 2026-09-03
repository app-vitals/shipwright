/*
  Warnings:

  - You are about to drop the column `taskId` on the `PullRequest` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "PullRequest_taskId_idx";

-- AlterTable
ALTER TABLE "PullRequest" DROP COLUMN "taskId";

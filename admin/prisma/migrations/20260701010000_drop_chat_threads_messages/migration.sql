-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_threadId_fkey";

-- DropForeignKey
ALTER TABLE "Thread" DROP CONSTRAINT "Thread_agentId_fkey";

-- DropIndex
DROP INDEX "Message_threadId_idx";

-- DropIndex
DROP INDEX "Thread_agentId_memberId_updatedAt_idx";

-- DropTable
DROP TABLE "Message";

-- DropTable
DROP TABLE "Thread";

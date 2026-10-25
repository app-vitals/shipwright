-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "askDepth" INTEGER,
ADD COLUMN     "askFromAgentId" TEXT,
ADD COLUMN     "kind" TEXT;

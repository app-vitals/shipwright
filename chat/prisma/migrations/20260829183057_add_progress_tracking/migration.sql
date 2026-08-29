-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "progressPhase" TEXT,
ADD COLUMN     "progressSeq" INTEGER NOT NULL DEFAULT 0;

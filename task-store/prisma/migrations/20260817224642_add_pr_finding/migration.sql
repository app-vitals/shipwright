-- CreateEnum
CREATE TYPE "PrFindingDisposition" AS ENUM ('resolved', 'superseded', 'rejected');

-- CreateEnum
CREATE TYPE "PrFindingSource" AS ENUM ('review', 'patch');

-- CreateTable
CREATE TABLE "PrFinding" (
    "id" TEXT NOT NULL,
    "prRecordId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "disposition" "PrFindingDisposition" NOT NULL,
    "source" "PrFindingSource" NOT NULL,
    "evidence" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrFinding_prRecordId_ref_idx" ON "PrFinding"("prRecordId", "ref");

-- CreateIndex
CREATE INDEX "PrFinding_prRecordId_source_idx" ON "PrFinding"("prRecordId", "source");

-- AddForeignKey
ALTER TABLE "PrFinding" ADD CONSTRAINT "PrFinding_prRecordId_fkey" FOREIGN KEY ("prRecordId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

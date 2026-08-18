-- CreateTable
CREATE TABLE "PullRequestEvent" (
    "id" TEXT NOT NULL,
    "prRecordId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "actor" TEXT,
    "method" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PullRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PullRequestEvent_prRecordId_at_idx" ON "PullRequestEvent"("prRecordId", "at");

-- AddForeignKey
ALTER TABLE "PullRequestEvent" ADD CONSTRAINT "PullRequestEvent_prRecordId_fkey" FOREIGN KEY ("prRecordId") REFERENCES "PullRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

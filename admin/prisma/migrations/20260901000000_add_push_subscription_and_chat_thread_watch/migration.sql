-- Web Push notifications for agent replies (CFB-4.2).
-- Two additive tables; no changes to existing tables.

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "detailOptIn" TEXT NOT NULL DEFAULT 'generic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThreadWatch" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatThreadWatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userEmail_idx" ON "PushSubscription"("userEmail");

-- CreateIndex
CREATE INDEX "ChatThreadWatch_threadId_idx" ON "ChatThreadWatch"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatThreadWatch_userEmail_threadId_key" ON "ChatThreadWatch"("userEmail", "threadId");

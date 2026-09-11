-- Session follow/notification-prefs/alert-state models (SES-6.1).
-- Three additive tables; no changes to existing tables.

-- CreateTable
CREATE TABLE "SessionFollow" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "sessionSlug" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionFollow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotificationPrefs" (
    "userEmail" TEXT NOT NULL,
    "autoFollowSessions" BOOLEAN NOT NULL DEFAULT true,
    "reminderHourLocal" INTEGER NOT NULL DEFAULT 9,
    "autoFollowSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNotificationPrefs_pkey" PRIMARY KEY ("userEmail")
);

-- CreateTable
CREATE TABLE "SessionAlertState" (
    "id" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "sessionSlug" TEXT NOT NULL,
    "lastAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionAlertState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionFollow_sessionSlug_idx" ON "SessionFollow"("sessionSlug");

-- CreateIndex
CREATE UNIQUE INDEX "SessionFollow_userEmail_sessionSlug_key" ON "SessionFollow"("userEmail", "sessionSlug");

-- CreateIndex
CREATE UNIQUE INDEX "SessionAlertState_userEmail_sessionSlug_key" ON "SessionAlertState"("userEmail", "sessionSlug");

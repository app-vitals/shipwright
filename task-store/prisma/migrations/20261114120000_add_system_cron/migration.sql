-- SCR-1.1: additive only — system-cron definitions and the per-slot trigger
-- table that makes POST /system-crons/:id/fire idempotent.

-- CreateTable
CREATE TABLE "SystemCronDefinition" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "titleTemplate" TEXT NOT NULL,
    "descriptionTemplate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemCronDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemCronTrigger" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "cronId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "slot" TEXT NOT NULL,
    "taskCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemCronTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemCronDefinition_accountId_idx" ON "SystemCronDefinition"("accountId");

-- CreateIndex
CREATE INDEX "SystemCronTrigger_accountId_idx" ON "SystemCronTrigger"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "SystemCronTrigger_cronId_scheduledFor_key" ON "SystemCronTrigger"("cronId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "SystemCronTrigger" ADD CONSTRAINT "SystemCronTrigger_cronId_fkey" FOREIGN KEY ("cronId") REFERENCES "SystemCronDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

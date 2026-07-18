-- AlterTable: add nullable parentCronId self-relation on AgentCronJob and
-- nullable phaseId FK on AgentCronRun.
-- LPC-1.1: a parent cron can have child "phase" crons (e.g. dev-task/review/
-- patch/deploy phases of a single logical loop); AgentCronRun.phaseId points
-- at the specific phase cron a run was dispatched by. Both columns are
-- purely additive and unused until later tasks (LPC-1.2, LPC-1.3, LPC-2.1,
-- LPC-3.1) wire them up.
ALTER TABLE "AgentCronJob" ADD COLUMN "parentCronId" TEXT;
ALTER TABLE "AgentCronRun" ADD COLUMN "phaseId" TEXT;

-- CreateIndex
CREATE INDEX "AgentCronJob_parentCronId_idx" ON "AgentCronJob"("parentCronId");

-- CreateIndex
CREATE INDEX "AgentCronRun_phaseId_idx" ON "AgentCronRun"("phaseId");

-- AddForeignKey
-- Deleting a parent cron cascades to its phase children.
ALTER TABLE "AgentCronJob" ADD CONSTRAINT "AgentCronJob_parentCronId_fkey" FOREIGN KEY ("parentCronId") REFERENCES "AgentCronJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull (not Cascade): phaseId is a secondary/denormalized pointer to the
-- phase cron; deleting a phase cron should not delete run history for the
-- parent cron (cronId's own Cascade already owns that).
ALTER TABLE "AgentCronRun" ADD CONSTRAINT "AgentCronRun_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "AgentCronJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

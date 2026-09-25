-- AddColumn: trialExpiresAt, trialExpiryWarnedAt TIMESTAMP(3) to Agent (additive, nullable, no backfill)
-- ATE-1.1: trial expiry tracking. Both columns default to NULL — trialExpiresAt
-- is user-settable via PATCH /agents/:id; trialExpiryWarnedAt is written
-- internally by ATE-2.1's warning check.
ALTER TABLE "Agent" ADD COLUMN     "trialExpiresAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN     "trialExpiryWarnedAt" TIMESTAMP(3);

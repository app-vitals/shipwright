-- AddColumn: autoPostReviews, allowSelfReview, minConfidence, maxFindings,
-- cleanupMergedWorktrees, cleanupAfterDays to Agent (additive, NOT NULL with
-- defaults, no backfill UPDATE needed)
-- APM-1.1: DB mirrors of the 6 real fields currently living only in each
-- agent's own state/agent-policy.md. Every existing row gets the documented
-- default via the column default below; a separate standalone script
-- (agent/scripts/backfill-agent-policy.ts) later overwrites a given agent's
-- row with its file's real values, same as patchAuthorAllowlist's original
-- addition — a fresh column needs no in-migration backfill UPDATE.
ALTER TABLE "Agent" ADD COLUMN     "autoPostReviews" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Agent" ADD COLUMN     "allowSelfReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN     "minConfidence" INTEGER NOT NULL DEFAULT 75;
ALTER TABLE "Agent" ADD COLUMN     "maxFindings" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Agent" ADD COLUMN     "cleanupMergedWorktrees" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Agent" ADD COLUMN     "cleanupAfterDays" INTEGER NOT NULL DEFAULT 14;

-- AddColumn: reviewAuthorAllowlist TEXT[] to Agent, then backfill from the
-- existing authorAllowlist column for every pre-existing row.
--
-- Unlike patchAuthorAllowlist (a brand-new, independent column added by the
-- sibling DBR-1.1 task with nothing to backfill), reviewAuthorAllowlist is a
-- rename-in-progress of the EXISTING authorAllowlist column: every row that
-- already has authorAllowlist values must carry them forward here too, not
-- just default to an empty array. The backfill runs inside this migration's
-- transaction, before the NOT NULL constraint is applied, so it's safe to
-- set NOT NULL directly (mirrors patchAuthorAllowlist's single-migration
-- approach rather than authorAllowlist's original two-migration
-- add-then-enforce-NOT-NULL pattern).
ALTER TABLE "Agent" ADD COLUMN "reviewAuthorAllowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill: copy every existing row's authorAllowlist value across so the
-- two columns start in sync. New rows created after this migration get both
-- columns written explicitly at the application layer (dual-write).
UPDATE "Agent" SET "reviewAuthorAllowlist" = "authorAllowlist";

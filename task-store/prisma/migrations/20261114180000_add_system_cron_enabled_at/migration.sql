-- SCR-1.3: additive only — when each system-cron definition was last enabled.
-- The scheduler's catch-up baseline is max(last claimed slot, enabledAt), so
-- enabling a definition never replays slots from before it was enabled.

-- AlterTable
ALTER TABLE "SystemCronDefinition" ADD COLUMN "enabledAt" TIMESTAMP(3);

-- Backfill: an already-enabled definition counts as enabled at its last update.
UPDATE "SystemCronDefinition" SET "enabledAt" = "updatedAt" WHERE "enabled" = true;

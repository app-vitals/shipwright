-- SCR-1.3: additive only — when each system-cron definition was last enabled.
-- The scheduler's catch-up baseline is max(last claimed slot, enabledAt), so
-- enabling a definition never replays slots from before it was enabled.

-- AlterTable
ALTER TABLE "SystemCronDefinition" ADD COLUMN "enabledAt" TIMESTAMP(3);

-- Backfill: an already-enabled definition counts as enabled now, so the first
-- tick after deploy starts fresh instead of replaying every slot since its last
-- edit (nothing scheduled system crons before this, so no trigger rows exist).
UPDATE "SystemCronDefinition" SET "enabledAt" = NOW() WHERE "enabled" = true;

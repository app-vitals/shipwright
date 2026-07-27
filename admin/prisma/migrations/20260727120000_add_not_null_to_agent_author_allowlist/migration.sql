-- Backfill NULL authorAllowlist rows, then enforce NOT NULL (mirrors the repos column)
UPDATE "Agent" SET "authorAllowlist" = '{}' WHERE "authorAllowlist" IS NULL;
ALTER TABLE "Agent" ALTER COLUMN "authorAllowlist" SET NOT NULL;

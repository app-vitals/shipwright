-- Migration: consolidate cron-run token accounting onto AgentCronRunModelBreakdown.
-- CTT-2.1: AgentCronRunModelBreakdown becomes the sole source of truth for all
-- cron-run token aggregation. The per-run token columns on AgentCronRun are
-- dropped in favour of a single LEFT JOIN + SUM against the breakdown table.
--
-- Step 1: backfill a synthetic breakdown row for every AgentCronRun that carries
-- token data but has no breakdown row yet (i.e. pre-2026-07-01 runs whose usage
-- was recorded before AgentCronRunModelBreakdown existed). The real per-run model
-- name and costUsd for those runs were already dropped by migration
-- 20260701030000_drop_cron_run_legacy_columns before this table existed, so they
-- surface under the placeholder model 'legacy-unattributed' with cost $0. Token
-- counts were never dropped and are preserved verbatim by this backfill.
--
-- The synthetic id is 'legacy-' || r.id so the insert needs no id-generation
-- extension (e.g. pgcrypto/gen_random_uuid) — r.id is already unique, so the
-- prefixed value is unique too and collision-free with cuid()-generated ids.
INSERT INTO "AgentCronRunModelBreakdown" (
    "id",
    "cronRunId",
    "model",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "costUsd"
)
SELECT
    'legacy-' || r."id",
    r."id",
    'legacy-unattributed',
    COALESCE(r."inputTokens", 0),
    COALESCE(r."outputTokens", 0),
    COALESCE(r."cacheReadTokens", 0),
    COALESCE(r."cacheCreationTokens", 0),
    0
FROM "AgentCronRun" r
WHERE (
        COALESCE(r."inputTokens", 0) <> 0
        OR COALESCE(r."outputTokens", 0) <> 0
        OR COALESCE(r."cacheReadTokens", 0) <> 0
        OR COALESCE(r."cacheCreationTokens", 0) <> 0
    )
    AND NOT EXISTS (
        SELECT 1
        FROM "AgentCronRunModelBreakdown" b
        WHERE b."cronRunId" = r."id"
    );

-- Step 2: drop the now-redundant per-run token columns. All token aggregation
-- reads from AgentCronRunModelBreakdown from here on.
ALTER TABLE "AgentCronRun" DROP COLUMN IF EXISTS "inputTokens";
ALTER TABLE "AgentCronRun" DROP COLUMN IF EXISTS "outputTokens";
ALTER TABLE "AgentCronRun" DROP COLUMN IF EXISTS "cacheReadTokens";
ALTER TABLE "AgentCronRun" DROP COLUMN IF EXISTS "cacheCreationTokens";

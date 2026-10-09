-- Widen daily chat token counters to BIGINT: accumulated per-model daily sums
-- overflow INT4 (SQLSTATE 22003) — see Sentry VITALS-OS-5T.
ALTER TABLE "AgentChatTokenUsageDailyByModel"
    ALTER COLUMN "inputTokens" TYPE BIGINT,
    ALTER COLUMN "outputTokens" TYPE BIGINT,
    ALTER COLUMN "cacheReadTokens" TYPE BIGINT,
    ALTER COLUMN "cacheCreationTokens" TYPE BIGINT;

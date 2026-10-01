-- SRB-1.1: add lastSkipReason so recordSkip()'s auto-block streak only counts
-- consecutive occurrences of the same skip reason instead of every skip
-- regardless of cause.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "lastSkipReason" TEXT;

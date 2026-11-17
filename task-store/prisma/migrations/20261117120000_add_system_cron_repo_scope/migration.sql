-- CRS-1.1: additive only — per-definition repo scope. Existing definitions
-- default to 'all' with no repos, so their behavior is unchanged.

-- AlterTable
ALTER TABLE "SystemCronDefinition" ADD COLUMN     "repoScope" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN     "repos" TEXT[] DEFAULT ARRAY[]::TEXT[];

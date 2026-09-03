-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "patchAuthorAllowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

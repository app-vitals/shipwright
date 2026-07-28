-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "authorAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[];

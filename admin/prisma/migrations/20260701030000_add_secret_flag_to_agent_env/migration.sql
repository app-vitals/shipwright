-- AlterTable: add secret column to AgentEnv with default false
ALTER TABLE "AgentEnv" ADD COLUMN "secret" BOOLEAN NOT NULL DEFAULT false;

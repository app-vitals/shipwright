-- AlterTable: add nullable itemType/itemId columns to AgentCronRun
-- WLS-2.2: the unified loop (shipwright-loop) dispatches a one-shot command
-- against a specific work item (a task id like "WLS-2.2" or a PR id like
-- "acme/x#123"). itemType ("task" | "pr") and itemId record which item a
-- given run was dispatched against, so the admin UI and metrics can spot an
-- agent spinning on the same item run after run. Both columns are nullable:
-- a tick with no dispatch (skipped tick, empty queue) leaves them null, and
-- pre-existing rows are left untouched (no backfill).
ALTER TABLE "AgentCronRun" ADD COLUMN "itemType" TEXT;
ALTER TABLE "AgentCronRun" ADD COLUMN "itemId" TEXT;

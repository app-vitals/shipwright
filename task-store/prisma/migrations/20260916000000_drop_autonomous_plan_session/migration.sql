-- TKD-1.3: drop the legacy `autonomousPlanSession` boolean now that every
-- writer (squadron, TKD-1.2) has moved onto `kind: "prd"` and a live-data
-- check confirmed zero tasks created with the legacy flag in the last 7 days.

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "autonomousPlanSession";

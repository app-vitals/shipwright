-- AddColumn: restrictSlackToMembers BOOLEAN to Agent (additive, non-breaking)
-- Existing agents default to restrictSlackToMembers: false (unrestricted).
ALTER TABLE "Agent" ADD COLUMN "restrictSlackToMembers" BOOLEAN NOT NULL DEFAULT false;

-- AddColumn: repos TEXT[] to Agent (additive, non-breaking)
-- Existing agents default to repos: []
ALTER TABLE "Agent" ADD COLUMN "repos" TEXT[] NOT NULL DEFAULT '{}';

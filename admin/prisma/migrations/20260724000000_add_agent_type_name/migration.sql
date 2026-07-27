-- AddColumn: typeName TEXT to Agent (additive, non-breaking)
-- Existing agents default to typeName: "coding"
ALTER TABLE "Agent" ADD COLUMN "typeName" TEXT NOT NULL DEFAULT 'coding';

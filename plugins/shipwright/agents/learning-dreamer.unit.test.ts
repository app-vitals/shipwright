import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = import.meta.dir;
const LEARNING_DREAMER_PATH = join(AGENT_DIR, "learning-dreamer.md");
const content = readFileSync(LEARNING_DREAMER_PATH, "utf-8");

describe("learning-dreamer.md — Harness TODO flush, step 5 hitl-seeding fallback", () => {
  it("no longer tells the agent to leave the entry in the queue", () => {
    expect(content).not.toContain("Leave the entry in the queue");
  });

  it("describes seeding a hitl:true task in the task store", () => {
    const hasHitlSeed =
      content.includes('"hitl": true') && content.includes("task store");
    expect(hasHitlSeed).toBe(true);
  });

  it("documents the POST /tasks curl pattern", () => {
    const hasPostPattern =
      content.includes("POST") && content.includes('"$SHIPWRIGHT_TASK_STORE_URL/tasks"');
    expect(hasPostPattern).toBe(true);
  });

  it("explicitly says to omit branch and states the reason why", () => {
    const hasOmitBranch =
      content.includes("omit `branch`") || content.includes("Omit `branch`");
    const hasReason =
      content.includes("task-schema.md") && content.includes("skips the task");
    expect(hasOmitBranch && hasReason).toBe(true);
  });

  it("states the broad trigger condition — not narrowly scoped to other plugins", () => {
    const hasBroadTrigger =
      content.includes("broad") && content.includes("other plugins");
    expect(hasBroadTrigger).toBe(true);
  });

  it("says to remove the entry from the Harness TODO queue once seeded", () => {
    const hasRemoval =
      content.includes("Once seeded, remove the entry from `# Harness TODO`");
    expect(hasRemoval).toBe(true);
  });
});

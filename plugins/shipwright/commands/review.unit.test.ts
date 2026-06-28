import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_MD_PATH = join(import.meta.dir, "review.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_MD_PATH, "utf-8");
});

describe("review.md — TRR-1.2 test-readiness context", () => {
  it("Step 5.7 references test-system.md as the source for test-readiness context (AC1)", () => {
    // The gather step must name the file it reads for test-readiness context
    const hasTestSystemMd = content.includes("test-system.md");
    expect(hasTestSystemMd).toBe(true);
  });

  it("Step 6 mentions 'Testing changes' classification", () => {
    // Step 6 classify-changes step must include a Testing changes bullet
    const hasTestingChanges = content.includes("Testing changes");
    expect(hasTestingChanges).toBe(true);
  });

  it("Step 7 mentions testReadinessContext as a field passed to the subagent", () => {
    // Step 7 subagent dispatch must reference testReadinessContext as a named field
    const hasTestReadinessContext = content.includes("testReadinessContext");
    expect(hasTestReadinessContext).toBe(true);
  });
});

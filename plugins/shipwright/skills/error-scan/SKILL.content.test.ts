import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let content: string;

beforeAll(() => {
  content = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");
});

describe("SKILL.md — capped final summary (CSM-2.7)", () => {
  it("caps the final summary at 3-5 lines and keeps detail in the report file", () => {
    const section = content.match(/## Step \d+: Print Summary[\s\S]*?\n---/)?.[0] ?? "";
    expect(section).toContain("3-5 lines");
    expect(section).toContain("ERROR SCAN COMPLETE");
    expect(section).toContain("error-report.md");
    expect(section).not.toContain("━");
  });
});

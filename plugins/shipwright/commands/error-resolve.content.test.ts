import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_PATH = join(
  import.meta.dir,
  "..",
  "skills",
  "error-resolve",
  "SKILL.md",
);
const COMMAND_PATH = join(import.meta.dir, "error-resolve.md");

let skill: string;
let command: string;

beforeAll(() => {
  skill = readFileSync(SKILL_PATH, "utf-8");
  command = readFileSync(COMMAND_PATH, "utf-8");
});

describe("error-resolve — resolving statuses (MPD-1.6)", () => {
  it("skill lists deployed and done as the only resolving statuses", () => {
    expect(skill).toContain(
      "`deployed` and `done` are the only resolving statuses",
    );
  });

  it("skill states merged, released and pr_open never resolve", () => {
    expect(skill).toMatch(/`merged`, `released` and `pr_open` never resolve/);
    expect(skill).toContain("published library");
  });

  it("command states merged, released and pr_open never resolve", () => {
    expect(command).toMatch(/`merged`, `released` and `pr_open` never/);
  });
});

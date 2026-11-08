import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FILES = [
  "commands/review.md",
  "commands/patch.md",
  "commands/merge.md",
  "skills/review-staged/SKILL.md",
];

describe("own-login resolution uses the canonical login helper (MGI-1.3)", () => {
  for (const file of FILES) {
    const content = readFileSync(join(ROOT, file), "utf-8");

    it(`${file} resolves own login via login-identity.ts`, () => {
      expect(content).toContain("scripts/login-identity.ts");
    });

    it(`${file} does not call the REST user endpoint`, () => {
      expect(content).not.toMatch(/gh api \/?user\b/);
    });
  }
});

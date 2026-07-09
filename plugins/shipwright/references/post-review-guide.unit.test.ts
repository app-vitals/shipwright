import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const POST_REVIEW_GUIDE_PATH = join(import.meta.dir, "post-review-guide.md");

let content: string;
let bodyGuidelinesSection: string;

beforeAll(() => {
  content = readFileSync(POST_REVIEW_GUIDE_PATH, "utf-8");

  const startIdx = content.indexOf("### Body Guidelines");
  const endIdx = content.indexOf("### Tone");
  expect(startIdx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(startIdx);
  bodyGuidelinesSection = content.slice(startIdx, endIdx);
});

describe("post-review-guide.md — CPF-2.2 verdict phrase requirement", () => {
  it("APPROVE example body includes the literal phrase 'Verdict: APPROVE'", () => {
    expect(bodyGuidelinesSection.includes("Verdict: APPROVE")).toBe(true);
  });

  it("COMMENT example body includes the literal phrase 'Verdict: COMMENT'", () => {
    expect(bodyGuidelinesSection.includes("Verdict: COMMENT")).toBe(true);
  });

  it("notes that the phrase is load-bearing for check-patch.ts's self-review dedup, not just stylistic", () => {
    expect(bodyGuidelinesSection.includes("check-patch.ts")).toBe(true);
    const mentionsLoadBearing =
      bodyGuidelinesSection.includes("load-bearing") ||
      bodyGuidelinesSection.includes("load bearing");
    expect(mentionsLoadBearing).toBe(true);
  });
});

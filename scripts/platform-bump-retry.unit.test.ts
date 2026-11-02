import { describe, expect, test } from "bun:test";
import {
  type BumpPr,
  decide,
  isRed,
  MAX_RETRIES,
  versionFromTitle,
} from "./platform-bump-retry.ts";

const TITLE = "chore(deps): bump @app-vitals/agent-* to 0.16.3";
const pr = (over: Partial<BumpPr> = {}): BumpPr => ({
  title: TITLE,
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  ...over,
});
const red = [
  { status: "COMPLETED", conclusion: "SUCCESS" },
  { status: "COMPLETED", conclusion: "FAILURE" },
];

describe("versionFromTitle", () => {
  test("reads the pinned version", () => {
    expect(versionFromTitle(TITLE)).toBe("0.16.3");
  });
  test("null when absent", () => {
    expect(versionFromTitle("chore: something")).toBeNull();
  });
});

describe("isRed", () => {
  test("legacy status contexts use state", () => {
    expect(isRed(pr({ statusCheckRollup: [{ state: "FAILURE" }] }))).toBe(true);
  });
  test("pending is not red", () => {
    expect(
      isRed(pr({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] })),
    ).toBe(false);
  });
});

describe("decide", () => {
  test("open-red retries with the PR's version", () => {
    const d = decide([pr({ statusCheckRollup: red })], 0);
    expect(d).toMatchObject({ action: "retry", version: "0.16.3" });
  });
  test("open-stale (conflicting) retries", () => {
    expect(decide([pr({ mergeable: "CONFLICTING" })], 1).action).toBe("retry");
  });
  test("open-green is a no-op", () => {
    expect(decide([pr()], 0).action).toBe("noop");
  });
  test("none is a no-op", () => {
    expect(decide([], 0).action).toBe("noop");
  });
  test("attempts-exhausted stops retrying", () => {
    const d = decide([pr({ statusCheckRollup: red })], MAX_RETRIES);
    expect(d).toMatchObject({ action: "exhausted", version: "0.16.3" });
  });
  test("last allowed attempt still retries", () => {
    expect(decide([pr({ statusCheckRollup: red })], MAX_RETRIES - 1).action).toBe(
      "retry",
    );
  });
  test("unparseable title is a no-op", () => {
    expect(decide([pr({ title: "x", statusCheckRollup: red })], 0).action).toBe(
      "noop",
    );
  });
});

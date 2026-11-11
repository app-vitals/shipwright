import { describe, expect, test } from "bun:test";
import {
  type BumpPr,
  decide,
  isGreen,
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
      isRed(
        pr({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }),
      ),
    ).toBe(false);
  });
});

describe("isGreen", () => {
  test("skipped counts as green", () => {
    expect(
      isGreen(
        pr({
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SKIPPED" }],
        }),
      ),
    ).toBe(true);
  });
  test("legacy status contexts use state", () => {
    expect(isGreen(pr({ statusCheckRollup: [{ state: "SUCCESS" }] }))).toBe(
      true,
    );
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
  test("open-green merges without a retry", () => {
    expect(decide([pr()], 0)).toMatchObject({
      action: "merge",
      version: "0.16.3",
    });
  });
  test("green-with-human-commits merges (no re-dispatch, so commits stay)", () => {
    const d = decide([pr({ headRefOid: "abc123" })], MAX_RETRIES);
    expect(d.action).toBe("merge");
  });
  test("green but merge already attempted for this head is a no-op", () => {
    expect(decide([pr()], 0, MAX_RETRIES, true).action).toBe("noop");
  });
  test("green but conflicting still retries", () => {
    expect(decide([pr({ mergeable: "CONFLICTING" })], 0).action).toBe("retry");
  });
  test("still-running is a no-op", () => {
    const running = [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS", conclusion: "" },
    ];
    expect(decide([pr({ statusCheckRollup: running })], 0).action).toBe("noop");
  });
  test("no checks yet is a no-op", () => {
    expect(decide([pr({ statusCheckRollup: [] })], 0).action).toBe("noop");
  });
  test("none is a no-op", () => {
    expect(decide([], 0).action).toBe("noop");
  });
  test("red PR with non-bot commits is exhausted without spending retries", () => {
    const d = decide([pr({ statusCheckRollup: red })], 0, MAX_RETRIES, false, true);
    expect(d).toMatchObject({ action: "exhausted", version: "0.16.3" });
  });
  test("conflicting PR with non-bot commits is exhausted", () => {
    const d = decide([pr({ mergeable: "CONFLICTING" })], 0, MAX_RETRIES, false, true);
    expect(d.action).toBe("exhausted");
  });
  test("green PR with non-bot commits still merges", () => {
    const d = decide([pr()], 0, MAX_RETRIES, false, true);
    expect(d.action).toBe("merge");
  });
  test("attempts-exhausted stops retrying", () => {
    const d = decide([pr({ statusCheckRollup: red })], MAX_RETRIES);
    expect(d).toMatchObject({ action: "exhausted", version: "0.16.3" });
  });
  test("last allowed attempt still retries", () => {
    expect(
      decide([pr({ statusCheckRollup: red })], MAX_RETRIES - 1).action,
    ).toBe("retry");
  });
  test("unparseable title is a no-op", () => {
    expect(decide([pr({ title: "x", statusCheckRollup: red })], 0).action).toBe(
      "noop",
    );
  });
});

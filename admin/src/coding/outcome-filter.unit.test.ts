import { describe, expect, test } from "bun:test";
import {
  appendOutcomeParams,
  DEFAULT_OUTCOMES,
  parseOutcomeParams,
  renderOutcomeOptions,
} from "./outcome-filter.ts";

describe("parseOutcomeParams", () => {
  test("no values -> default selection (skipped hidden)", () => {
    expect(parseOutcomeParams([])).toEqual(["completed", "failed", "unknown"]);
    expect(parseOutcomeParams([])).toEqual([...DEFAULT_OUTCOMES]);
  });

  test("blank values fall back to the default", () => {
    expect(parseOutcomeParams(["", "  "])).toEqual([...DEFAULT_OUTCOMES]);
  });

  test("repeated values are kept, deduped, in order", () => {
    expect(parseOutcomeParams(["skipped", "failed", "skipped"])).toEqual([
      "skipped",
      "failed",
    ]);
  });

  test("a single legacy value still works", () => {
    expect(parseOutcomeParams(["error"])).toEqual(["error"]);
  });
});

describe("renderOutcomeOptions", () => {
  test("renders the four options and marks only the selected ones", () => {
    const html = renderOutcomeOptions(["skipped"]);
    expect(html).toContain('<option value="skipped" selected>skipped</option>');
    expect(html).toContain('<option value="completed">completed</option>');
    expect(html).toContain('<option value="failed">failed</option>');
    expect(html).toContain('<option value="unknown">unknown</option>');
  });
});

describe("appendOutcomeParams", () => {
  test("appends one outcome param per selected value", () => {
    const params = new URLSearchParams();
    appendOutcomeParams(params, ["completed", "skipped"]);
    expect(params.toString()).toBe("outcome=completed&outcome=skipped");
  });
});

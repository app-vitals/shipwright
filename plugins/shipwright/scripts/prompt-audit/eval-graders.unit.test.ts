import { describe, expect, test } from "bun:test";
import {
  assertJudgeFamily,
  type Grader,
  graderName,
  isMechanical,
  modelFamily,
  unsupportedReason,
} from "./eval-graders.ts";

const judge: Grader = { type: "llm_judge", model: "gpt-5", rubric: "r" };
const contains: Grader = { type: "transcript_contains", text: "x" };
const tests: Grader = { type: "tests_pass", command: "bun test" };
const store: Grader = {
  type: "task_store_state",
  taskId: "T-1",
  field: "status",
  expected: "done",
};

describe("eval-graders", () => {
  test("isMechanical is false only for llm_judge", () => {
    expect(isMechanical(judge)).toBe(false);
    expect(isMechanical(contains)).toBe(true);
    expect(isMechanical(tests)).toBe(true);
  });

  test("unsupportedReason names the two unsupported grader types only", () => {
    expect(unsupportedReason(tests)).toContain("tests_pass");
    expect(unsupportedReason(store)).toContain("task_store_state");
    expect(unsupportedReason(contains)).toBeUndefined();
    expect(unsupportedReason(judge)).toBeUndefined();
  });

  test("graderName zero-pads the 1-based index and appends the type", () => {
    expect(graderName(contains, 0)).toBe("01-transcript_contains.md");
    expect(graderName(judge, 11)).toBe("12-llm_judge.md");
  });

  test("modelFamily strips provider prefix and takes the first segment", () => {
    expect(modelFamily("anthropic/claude-opus-4")).toBe("claude");
    expect(modelFamily("GPT-5.1")).toBe("gpt");
  });

  test("assertJudgeFamily rejects a same-family judge", () => {
    expect(() => assertJudgeFamily("claude-opus-4", "claude-haiku-4")).toThrow(
      /different family/,
    );
    expect(() => assertJudgeFamily("claude-opus-4", "gpt-5")).not.toThrow();
  });
});

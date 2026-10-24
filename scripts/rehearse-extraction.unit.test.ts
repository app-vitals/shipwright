import { describe, expect, test } from "bun:test";
import { failureBlocks } from "./rehearse-extraction";

const run = [
  "(pass) a > one [0.1ms]",
  "(pass) a > two [0.1ms]",
  "error: launch: Executable doesn't exist",
  "    at launchBrowser (browser.ts:29:19)",
  "(fail) browser > launches [4ms]",
  "(pass) b > three [0.1ms]",
  "error: db down",
  "(fail) cron > reconciles [12ms]",
  "",
  " 2 pass",
  " 2 fail",
].join("\n");

describe("failureBlocks", () => {
  test("keeps the error output above each failing test and nothing else", () => {
    expect(failureBlocks(run)).toBe(
      [
        "error: launch: Executable doesn't exist",
        "    at launchBrowser (browser.ts:29:19)",
        "(fail) browser > launches [4ms]",
        "",
        "error: db down",
        "(fail) cron > reconciles [12ms]",
      ].join("\n"),
    );
  });

  test("is empty when nothing failed", () => {
    expect(failureBlocks("(pass) a > one [0.1ms]\n 1 pass")).toBe("");
  });

  test("caps the number of failures and the lines kept per failure", () => {
    const many = Array.from({ length: 5 }, (_, i) => `(fail) t${i}`).join("\n");
    expect(failureBlocks(many, 2).split("\n\n")).toHaveLength(2);
    const noisy = `${"x\n".repeat(50)}(fail) noisy`;
    expect(failureBlocks(noisy, 12, 3).split("\n")).toHaveLength(4);
  });
});

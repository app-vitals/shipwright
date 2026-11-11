/**
 * plugins/shipwright/scripts/prompt-audit/blame-age.unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import { analyzeBlameAge, parseBlamePorcelain } from "./blame-age.ts";

const DAY = 86_400;
const NOW = 1_000 * DAY;
const sha = (c: string) => c.repeat(40);

function entry(c: string, finalLine: number, daysAgo: number, text: string) {
  return [
    `${sha(c)} ${finalLine} ${finalLine} 1`,
    "author Someone",
    `author-time ${NOW - daysAgo * DAY}`,
    "summary msg",
    "filename SKILL.md",
    `\t${text}`,
  ].join("\n");
}

const RECORDED = [
  entry("a", 1, 10, "first"),
  entry("b", 2, 100, "second"),
  entry("c", 3, 30, "third"),
  entry("d", 4, 100, "fourth"),
].join("\n");

describe("blame-age", () => {
  test("parses line and author-time from porcelain output", () => {
    const rows = parseBlamePorcelain(RECORDED);
    expect(rows).toEqual([
      [1, NOW - 10 * DAY],
      [2, NOW - 100 * DAY],
      [3, NOW - 30 * DAY],
      [4, NOW - 100 * DAY],
    ]);
  });

  test("computes max, median, and oldest line via injected exec", () => {
    const calls: string[][] = [];
    const r = analyzeBlameAge("SKILL.md", {
      now: NOW,
      exec: (cmd) => {
        calls.push(cmd);
        return RECORDED;
      },
    });
    expect(calls[0]).toEqual([
      "git",
      "blame",
      "--line-porcelain",
      "--",
      "SKILL.md",
    ]);
    expect(r.lines).toBe(4);
    expect(r.maxAgeDays).toBe(100);
    expect(r.medianAgeDays).toBe(65);
    expect(r.oldestLine).toEqual({ line: 2, ageDays: 100 });
  });

  test("empty blame output yields zeros", () => {
    expect(analyzeBlameAge("x", { now: NOW, exec: () => "" })).toEqual({
      lines: 0,
      maxAgeDays: 0,
      medianAgeDays: 0,
      oldestLine: null,
    });
  });
});

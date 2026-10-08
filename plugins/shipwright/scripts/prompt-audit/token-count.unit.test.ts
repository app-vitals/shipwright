/**
 * plugins/shipwright/scripts/prompt-audit/token-count.unit.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COUNT_TOKENS_URL,
  type CountFetch,
  countTokens,
  estimateTokens,
  listingBudget,
} from "./token-count.ts";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "token-count-"));
  cachePath = join(dir, "nested", "token-cache.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function recordingFetch(
  recorded: Array<{ url: string; init: Parameters<CountFetch>[1] }>,
): CountFetch {
  return async (url, init) => {
    recorded.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ input_tokens: 42 }) };
  };
}

describe("countTokens", () => {
  test("no key: every figure is estimated ceil(bytes/4) and fetch is never called", async () => {
    const calls: Array<{ url: string; init: Parameters<CountFetch>[1] }> = [];
    const res = await countTokens(["abcdefghi"], ["claude-sonnet-5-5"], {
      apiKey: "",
      fetchFn: recordingFetch(calls),
      cachePath,
    });
    expect(res["claude-sonnet-5-5"]).toEqual([{ tokens: 3, estimated: true }]);
    expect(calls).toHaveLength(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("with key: posts the target model id and returns the recorded count", async () => {
    const calls: Array<{ url: string; init: Parameters<CountFetch>[1] }> = [];
    const res = await countTokens(["hello"], ["claude-opus-5-5"], {
      apiKey: "sk-test",
      fetchFn: recordingFetch(calls),
      cachePath,
    });
    expect(res["claude-opus-5-5"]).toEqual([{ tokens: 42, estimated: false }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(COUNT_TOKENS_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["x-api-key"]).toBe("sk-test");
    expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("second run on unchanged content makes zero calls", async () => {
    const calls: Array<{ url: string; init: Parameters<CountFetch>[1] }> = [];
    const deps = {
      apiKey: "sk-test",
      fetchFn: recordingFetch(calls),
      cachePath,
    };
    await countTokens(["a", "b"], ["claude-opus-5-5"], deps);
    expect(calls).toHaveLength(2);
    const again = await countTokens(["a", "b"], ["claude-opus-5-5"], deps);
    expect(calls).toHaveLength(2);
    expect(again["claude-opus-5-5"]).toEqual([
      { tokens: 42, estimated: false },
      { tokens: 42, estimated: false },
    ]);
  });

  test("cache is keyed by model and content", async () => {
    const calls: Array<{ url: string; init: Parameters<CountFetch>[1] }> = [];
    const deps = {
      apiKey: "sk-test",
      fetchFn: recordingFetch(calls),
      cachePath,
    };
    await countTokens(["a"], ["claude-opus-5-5"], deps);
    await countTokens(["a"], ["claude-haiku-4-5"], deps);
    await countTokens(["changed"], ["claude-opus-5-5"], deps);
    expect(calls).toHaveLength(3);
  });

  test("non-2xx falls back to an uncached estimate", async () => {
    let n = 0;
    const failing: CountFetch = async () => {
      n++;
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const deps = { apiKey: "sk-test", fetchFn: failing, cachePath };
    const res = await countTokens(["abcd"], ["claude-opus-5-5"], deps);
    expect(res["claude-opus-5-5"]).toEqual([{ tokens: 1, estimated: true }]);
    await countTokens(["abcd"], ["claude-opus-5-5"], deps);
    expect(n).toBe(2);
  });

  test("thrown fetch and malformed body fall back to estimate", async () => {
    const throwing: CountFetch = async () => {
      throw new Error("network");
    };
    const malformed: CountFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    for (const fetchFn of [throwing, malformed]) {
      const res = await countTokens(["abcdefgh"], ["claude-opus-5-5"], {
        apiKey: "k",
        fetchFn,
        cachePath,
      });
      expect(res["claude-opus-5-5"]).toEqual([{ tokens: 2, estimated: true }]);
    }
  });
});

describe("estimateTokens", () => {
  test("counts bytes, not characters", () => {
    expect(estimateTokens("é")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("listingBudget", () => {
  test("is 1% of the model context window in chars", () => {
    expect(listingBudget("claude-opus-5-5")).toBe(10_000);
    expect(listingBudget("claude-haiku-4-5")).toBe(2_000);
  });
  test("unknown model is undefined", () => {
    expect(listingBudget("nope")).toBeUndefined();
  });
});

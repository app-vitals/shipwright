/**
 * plugins/shipwright/scripts/prompt-audit/token-count.ts
 *
 * Token counting for the prompt audit. Uses Anthropic's count_tokens endpoint
 * when an API key is available, otherwise (or on any failure) falls back to a
 * ceil(bytes/4) estimate labelled `estimated: true`. Real counts are cached on
 * disk by sha256(model + content) so unchanged files cost zero calls on re-run.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const COUNT_TOKENS_URL =
  "https://api.anthropic.com/v1/messages/count_tokens";
export const DEFAULT_CACHE_PATH = "state/prompt-audit/token-cache.json";

/** Claude Code reserves this fraction of the context window for the skill listing. */
const LISTING_FRACTION = 0.01;

/**
 * Plugin-local copy of lib/pricing CONTEXT_WINDOW (the plugin is
 * self-contained and cannot import from lib/). token-count-parity.unit.test.ts
 * fails if this drifts from the source of truth.
 */
export const CONTEXT_WINDOW: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-haiku-4-6": 200_000,
};

export interface TokenCount {
  tokens: number;
  estimated: boolean;
}

export type CountFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CountTokensDeps {
  fetchFn?: CountFetch;
  apiKey?: string;
  cachePath?: string;
}

/** Skill-listing budget in characters for a model (1% of its context window). */
export function listingBudget(model: string): number | undefined {
  const window = CONTEXT_WINDOW[model];
  return window === undefined
    ? undefined
    : Math.floor(window * LISTING_FRACTION);
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function cacheKey(model: string, content: string): string {
  return createHash("sha256")
    .update(model)
    .update("\0")
    .update(content)
    .digest("hex");
}

function loadCache(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function saveCache(path: string, cache: Record<string, number>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

async function fetchCount(
  text: string,
  model: string,
  apiKey: string,
  fetchFn: CountFetch,
): Promise<number | null> {
  try {
    const res = await fetchFn(COUNT_TOKENS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { input_tokens?: unknown };
    return typeof body.input_tokens === "number" ? body.input_tokens : null;
  } catch {
    return null;
  }
}

/**
 * Count tokens for each text under each model. Result is keyed by model, with
 * one entry per input text (same order). Estimates are never cached, so a
 * later run with a key replaces them with real counts.
 */
export async function countTokens(
  texts: string[],
  models: string[],
  deps: CountTokensDeps = {},
): Promise<Record<string, TokenCount[]>> {
  const apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchFn = deps.fetchFn ?? (fetch as unknown as CountFetch);
  const cachePath = deps.cachePath ?? DEFAULT_CACHE_PATH;
  const cache = apiKey ? loadCache(cachePath) : {};
  let dirty = false;

  const out: Record<string, TokenCount[]> = {};
  for (const model of models) {
    out[model] = [];
    for (const text of texts) {
      if (!apiKey) {
        out[model].push({ tokens: estimateTokens(text), estimated: true });
        continue;
      }
      const key = cacheKey(model, text);
      if (key in cache) {
        out[model].push({ tokens: cache[key], estimated: false });
        continue;
      }
      const tokens = await fetchCount(text, model, apiKey, fetchFn);
      if (tokens === null) {
        out[model].push({ tokens: estimateTokens(text), estimated: true });
        continue;
      }
      cache[key] = tokens;
      dirty = true;
      out[model].push({ tokens, estimated: false });
    }
  }
  if (dirty) saveCache(cachePath, cache);
  return out;
}

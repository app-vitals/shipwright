/**
 * metrics/src/posthog-client.ts
 * Typed PostHog HogQL client with dependency-injected fetch.
 * Queries PostHog via the HogQL API for dashboard metrics.
 */

import { Cache, buildCacheKey } from "./cache.ts";
import type {
  FetchFn,
  HogQLMetadataResponse,
  HogQLResponse,
  HogQLResult,
  HogQLValidationResult,
  PostHogConfig,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://us.posthog.com";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class PostHogClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "PostHogClientError";
  }
}

export function createPostHogClient(
  config: PostHogConfig,
  fetchFn: FetchFn = globalThis.fetch,
  cache: Cache<HogQLResult> = new Cache<HogQLResult>(),
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
) {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const queryUrl = `${baseUrl}/api/projects/${config.projectId}/query/`;

  async function handleHttpErrors(response: Response): Promise<void> {
    if (response.status === 401) {
      throw new PostHogClientError(
        "PostHog authentication failed — check personal API key",
        401,
      );
    }

    if (response.status === 429) {
      const retryAfter = Number.parseInt(
        response.headers.get("retry-after") ?? "60",
        10,
      );
      throw new PostHogClientError(
        `PostHog rate limit exceeded — retry after ${retryAfter}s`,
        429,
        retryAfter,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      throw new PostHogClientError(
        `PostHog query failed (${response.status}): ${text}`,
        response.status,
      );
    }
  }

  async function query(
    hogql: string,
    options?: { dateFrom?: string; dateTo?: string },
  ): Promise<HogQLResult> {
    const cacheKey = await buildCacheKey(
      hogql,
      options?.dateFrom,
      options?.dateTo,
    );
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const hogqlQuery: Record<string, unknown> = {
      kind: "HogQLQuery",
      query: hogql,
    };

    if (options?.dateFrom) {
      hogqlQuery.filters = {
        dateRange: { date_from: options.dateFrom, date_to: options?.dateTo },
      };
    }

    const body = { query: hogqlQuery };

    const response = await fetchFn(queryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.personalApiKey}`,
      },
      body: JSON.stringify(body),
    });

    await handleHttpErrors(response);

    const data = (await response.json()) as HogQLResponse;

    const result: HogQLResult = {
      columns: data.columns,
      results: data.results,
      types: data.types,
      hasMore: data.hasMore,
      limit: data.limit,
      offset: data.offset,
    };

    cache.set(cacheKey, result, cacheTtlMs);

    return result;
  }

  async function validate(hogql: string): Promise<HogQLValidationResult> {
    const body = {
      query: {
        kind: "HogQLMetadata",
        language: "hogQL",
        query: hogql,
      },
    };

    const response = await fetchFn(queryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.personalApiKey}`,
      },
      body: JSON.stringify(body),
    });

    await handleHttpErrors(response);

    const data = (await response.json()) as HogQLMetadataResponse;

    return {
      isValid: data.isValid,
      errors: data.errors,
    };
  }

  return { query, validate, clearCache: () => cache.clear() };
}

export type PostHogClient = ReturnType<typeof createPostHogClient>;

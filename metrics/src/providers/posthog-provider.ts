/**
 * metrics/src/providers/posthog-provider.ts
 * MetricsProvider backed by PostHog (HogQL). The ONLY place HogQL exists on
 * the read path: query(q) selects the matching builder, produces the HogQL
 * string, and hands it to the injected PostHogClientLike. Builder overrides
 * are accepted so existing sentinel-based DI tests route unchanged.
 */

import type { PostHogClientLike } from "../api.ts";
import type {
  MetricQuery,
  MetricTable,
  MetricsProvider,
} from "../metrics-provider.ts";
import type { QueryDateRange, TrendsGroupBy } from "../queries.ts";

/** The 13 HogQL builders, keyed by MetricQuery kind. */
export interface BuilderFns {
  summary: (range: QueryDateRange) => string;
  summaryCycleTime: (range: QueryDateRange) => string;
  trends: (range: QueryDateRange, groupBy: TrendsGroupBy) => string;
  featuresTasks: (range: QueryDateRange) => string;
  featuresCi: (range: QueryDateRange) => string;
  featuresReviews: (range: QueryDateRange) => string;
  queueFunnel: (range: QueryDateRange) => string;
  queueCycleStarted: (range: QueryDateRange) => string;
  queueCycleMerged: (range: QueryDateRange) => string;
  tokensTotals: (range: QueryDateRange) => string;
  tokensBySessionType: (range: QueryDateRange) => string;
  tokensByAgent: (range: QueryDateRange) => string;
  tokensTrends: (range: QueryDateRange) => string;
}

export class PostHogProvider implements MetricsProvider {
  constructor(
    private readonly client: PostHogClientLike,
    private readonly builders: BuilderFns,
  ) {}

  async query(q: MetricQuery): Promise<MetricTable> {
    const hogql = this.buildHogql(q);
    return this.client.query(hogql);
  }

  private buildHogql(q: MetricQuery): string {
    const b = this.builders;
    switch (q.kind) {
      case "summary":
        return b.summary(q.range);
      case "summaryCycleTime":
        return b.summaryCycleTime(q.range);
      case "trends":
        return b.trends(q.range, q.groupBy);
      case "featuresTasks":
        return b.featuresTasks(q.range);
      case "featuresCi":
        return b.featuresCi(q.range);
      case "featuresReviews":
        return b.featuresReviews(q.range);
      case "queueFunnel":
        return b.queueFunnel(q.range);
      case "queueCycleStarted":
        return b.queueCycleStarted(q.range);
      case "queueCycleMerged":
        return b.queueCycleMerged(q.range);
      case "tokensTotals":
        return b.tokensTotals(q.range);
      case "tokensBySessionType":
        return b.tokensBySessionType(q.range);
      case "tokensByAgent":
        return b.tokensByAgent(q.range);
      case "tokensTrends":
        return b.tokensTrends(q.range);
    }
  }
}

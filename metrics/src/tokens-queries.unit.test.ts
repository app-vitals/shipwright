/**
 * metrics/src/tokens-queries.unit.test.ts
 * Unit tests for token usage HogQL query builders.
 * RED phase — tests written before implementation.
 */

import { describe, expect, it } from "bun:test";
import {
  DENYLIST,
  type QueryDateRange,
  buildTokensByAgentQuery,
  buildTokensBySessionTypeQuery,
  buildTokensTotalsQuery,
  buildTokensTrendsQuery,
} from "./queries.ts";

const TOKEN_EVENT = "agent_token_usage";

// ─── buildTokensTotalsQuery ───────────────────────────────────────────────────

describe("buildTokensTotalsQuery", () => {
  it("filters to agent_token_usage event", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain(`event = '${TOKEN_EVENT}'`);
  });

  it("selects input_tokens", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("input_tokens");
  });

  it("selects output_tokens", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("output_tokens");
  });

  it("selects cache_read_input_tokens", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("cache_read_input_tokens");
  });

  it("selects cache_creation_input_tokens", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("cache_creation_input_tokens");
  });

  it("selects total as sum of all token types", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("total_tokens");
  });

  it("queries from events table", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("FROM events");
  });

  it("applies 7d date filter", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
  });

  it("applies today date filter", () => {
    const query = buildTokensTotalsQuery("today");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now(), 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "timestamp < toStartOfDay(now(), 'America/Los_Angeles') + interval 1 day",
    );
  });

  it("applies 30d date filter", () => {
    const query = buildTokensTotalsQuery("30d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 30 day, 'America/Los_Angeles')",
    );
  });

  it("applies 90d date filter", () => {
    const query = buildTokensTotalsQuery("90d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 90 day, 'America/Los_Angeles')",
    );
  });

  it("applies custom range date filter", () => {
    const query = buildTokensTotalsQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-07 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("emits the timezone argument", () => {
    expect(buildTokensTotalsQuery("today")).toContain("'America/Los_Angeles'");
  });

  it("uses sum() aggregates for token counts", () => {
    const query = buildTokensTotalsQuery("7d");
    expect(query).toContain("sum(");
  });
});

// ─── buildTokensBySessionTypeQuery ───────────────────────────────────────────

describe("buildTokensBySessionTypeQuery", () => {
  it("filters to agent_token_usage event", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain(`event = '${TOKEN_EVENT}'`);
  });

  it("groups by session_type", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("GROUP BY session_type");
  });

  it("selects session_type column", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("session_type");
  });

  it("selects input_tokens", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("input_tokens");
  });

  it("selects output_tokens", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("output_tokens");
  });

  it("selects cache_read_input_tokens", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("cache_read_input_tokens");
  });

  it("selects cache_creation_input_tokens", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("cache_creation_input_tokens");
  });

  it("selects total tokens column", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("total_tokens");
  });

  it("queries from events table", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("FROM events");
  });

  it("applies 7d date filter", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
  });

  it("applies custom range date filter", () => {
    const query = buildTokensBySessionTypeQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
  });

  it("references session_type property", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("properties.session_type");
  });

  it("uses sum() aggregates for token counts", () => {
    const query = buildTokensBySessionTypeQuery("7d");
    expect(query).toContain("sum(");
  });
});

// ─── buildTokensByAgentQuery ──────────────────────────────────────────────────

describe("buildTokensByAgentQuery", () => {
  it("filters to agent_token_usage event", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain(`event = '${TOKEN_EVENT}'`);
  });

  it("groups by agent_id", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("GROUP BY agent_id");
  });

  it("selects agent_id column", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("agent_id");
  });

  it("selects input_tokens", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("input_tokens");
  });

  it("selects output_tokens", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("output_tokens");
  });

  it("selects cache_read_input_tokens", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("cache_read_input_tokens");
  });

  it("selects cache_creation_input_tokens", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("cache_creation_input_tokens");
  });

  it("selects total tokens column", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("total_tokens");
  });

  it("queries from events table", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("FROM events");
  });

  it("applies 7d date filter", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
  });

  it("applies custom range date filter", () => {
    const query = buildTokensByAgentQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
  });

  it("references agent_id property", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("properties.agent_id");
  });

  it("uses sum() aggregates for token counts", () => {
    const query = buildTokensByAgentQuery("7d");
    expect(query).toContain("sum(");
  });
});

// ─── buildTokensTrendsQuery ───────────────────────────────────────────────────

describe("buildTokensTrendsQuery", () => {
  it("filters to agent_token_usage event", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain(`event = '${TOKEN_EVENT}'`);
  });

  it("groups by date using toDate(toTimeZone(timestamp, ...))", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain(
      "toDate(toTimeZone(timestamp, 'America/Los_Angeles'))",
    );
  });

  it("includes GROUP BY period", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("GROUP BY period");
  });

  it("includes ORDER BY period ASC", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("ORDER BY period ASC");
  });

  it("selects date/period column", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("AS period");
  });

  it("selects input_tokens", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("input_tokens");
  });

  it("selects output_tokens", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("output_tokens");
  });

  it("selects cache_read_input_tokens", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("cache_read_input_tokens");
  });

  it("selects cache_creation_input_tokens", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("cache_creation_input_tokens");
  });

  it("selects total tokens column", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("total_tokens");
  });

  it("queries from events table", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("FROM events");
  });

  it("applies 7d date filter", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
  });

  it("applies custom range date filter", () => {
    const query = buildTokensTrendsQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
  });

  it("emits the timezone argument", () => {
    expect(buildTokensTrendsQuery("today")).toContain("'America/Los_Angeles'");
  });

  it("uses sum() aggregates for token counts", () => {
    const query = buildTokensTrendsQuery("7d");
    expect(query).toContain("sum(");
  });
});

// ─── cost_usd select assertions ──────────────────────────────────────────────

describe("cost_usd select — all 4 token query builders", () => {
  it("buildTokensTotalsQuery selects cost_usd", () => {
    expect(buildTokensTotalsQuery("7d")).toContain("cost_usd");
  });

  it("buildTokensBySessionTypeQuery selects cost_usd", () => {
    expect(buildTokensBySessionTypeQuery("7d")).toContain("cost_usd");
  });

  it("buildTokensByAgentQuery selects cost_usd", () => {
    expect(buildTokensByAgentQuery("7d")).toContain("cost_usd");
  });

  it("buildTokensTrendsQuery selects cost_usd", () => {
    expect(buildTokensTrendsQuery("7d")).toContain("cost_usd");
  });
});

// ─── HogQL denylist guard ─────────────────────────────────────────────────────

describe("HogQL denylist guard — token queries (TU-2.1)", () => {
  const tokenBuilders: Array<[string, (dateRange: QueryDateRange) => string]> =
    [
      ["buildTokensTotalsQuery", buildTokensTotalsQuery],
      ["buildTokensBySessionTypeQuery", buildTokensBySessionTypeQuery],
      ["buildTokensByAgentQuery", buildTokensByAgentQuery],
      ["buildTokensTrendsQuery", buildTokensTrendsQuery],
    ];

  const DATE_RANGE: QueryDateRange = { from: "2026-01-01", to: "2026-03-31" };

  for (const [builderName, builder] of tokenBuilders) {
    for (const token of DENYLIST) {
      it(`${builderName} must not use ${token} (denylisted HogQL function)`, () => {
        const sql = builder(DATE_RANGE);
        expect(
          sql,
          `${builderName} must not use ${token} (denylisted HogQL function — PostHog returns 400)`,
        ).not.toContain(token);
      });
    }
  }
});

// ─── Direct typed prop rule ───────────────────────────────────────────────────

describe("Direct typed prop rule — token properties referenced directly", () => {
  const tokenBuilders = [
    buildTokensTotalsQuery,
    buildTokensBySessionTypeQuery,
    buildTokensByAgentQuery,
    buildTokensTrendsQuery,
  ];

  it("no toString() round-trips on numeric token properties", () => {
    for (const builder of tokenBuilders) {
      const query = builder("7d");
      expect(query).not.toContain("toString(properties.input_tokens)");
      expect(query).not.toContain("toString(properties.output_tokens)");
      expect(query).not.toContain(
        "toString(properties.cache_read_input_tokens)",
      );
      expect(query).not.toContain(
        "toString(properties.cache_creation_input_tokens)",
      );
    }
  });
});

// ─── PST timezone anchor ──────────────────────────────────────────────────────

describe("PST timezone anchor — token queries", () => {
  const tokenBuilders: Array<[string, (dateRange: QueryDateRange) => string]> =
    [
      ["buildTokensTotalsQuery", buildTokensTotalsQuery],
      ["buildTokensBySessionTypeQuery", buildTokensBySessionTypeQuery],
      ["buildTokensByAgentQuery", buildTokensByAgentQuery],
      ["buildTokensTrendsQuery", buildTokensTrendsQuery],
    ];

  for (const [name, builder] of tokenBuilders) {
    it(`${name}("today") emits the timezone argument`, () => {
      expect(builder("today")).toContain("'America/Los_Angeles'");
    });
  }

  it("does not emit any UTC-naive today() or interval expression", () => {
    for (const [, builder] of tokenBuilders) {
      const query = builder("today");
      expect(query).not.toMatch(/(?<!OfDay\()\btoday\(\)/);
      expect(query).not.toMatch(/now\(\) - interval \d+ day(?!,)/);
    }
  });
});

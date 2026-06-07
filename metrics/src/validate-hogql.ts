/**
 * metrics/src/validate-hogql.ts
 * Pre-deploy HogQL validation runner.
 *
 * Validates every exported query builder across all DatePresets via PostHog's
 * HogQLMetadata endpoint (no data scan — metadata-only, read-only key sufficient).
 * Exits non-zero on any isValid:false, naming the builder, offending function,
 * and PostHog error message.
 *
 * Usage:
 *   POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=<your-project-id> bun run validate:hogql
 *
 * In CI: set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID as CI secrets.
 * Both are required — the script exits immediately if either is missing.
 */

import { createPostHogClient } from "./posthog-client.ts";
import {
  buildFeaturesCiQuery,
  buildFeaturesReviewsQuery,
  buildFeaturesTasksQuery,
  buildQueueCycleMergedQuery,
  buildQueueCycleStartedQuery,
  buildQueueFunnelQuery,
  buildSummaryCycleTimeQuery,
  buildSummaryQuery,
  buildTokensByAgentQuery,
  buildTokensBySessionTypeQuery,
  buildTokensTotalsQuery,
  buildTokensTrendsQuery,
  buildTrendsQuery,
} from "./queries.ts";
import type { DatePreset } from "./types.ts";

const DATE_PRESETS: DatePreset[] = ["today", "7d", "30d", "90d"];

type Builder = { name: string; sql: string };

function allBuilders(): Builder[] {
  const out: Builder[] = [];
  for (const preset of DATE_PRESETS) {
    out.push(
      { name: `buildSummaryQuery(${preset})`, sql: buildSummaryQuery(preset) },
      {
        name: `buildSummaryCycleTimeQuery(${preset})`,
        sql: buildSummaryCycleTimeQuery(preset),
      },
      {
        name: `buildFeaturesTasksQuery(${preset})`,
        sql: buildFeaturesTasksQuery(preset),
      },
      {
        name: `buildFeaturesCiQuery(${preset})`,
        sql: buildFeaturesCiQuery(preset),
      },
      {
        name: `buildFeaturesReviewsQuery(${preset})`,
        sql: buildFeaturesReviewsQuery(preset),
      },
      {
        name: `buildQueueFunnelQuery(${preset})`,
        sql: buildQueueFunnelQuery(preset),
      },
      {
        name: `buildQueueCycleStartedQuery(${preset})`,
        sql: buildQueueCycleStartedQuery(preset),
      },
      {
        name: `buildQueueCycleMergedQuery(${preset})`,
        sql: buildQueueCycleMergedQuery(preset),
      },
      {
        name: `buildTrendsQuery(${preset}, day)`,
        sql: buildTrendsQuery(preset, "day"),
      },
      {
        name: `buildTrendsQuery(${preset}, week)`,
        sql: buildTrendsQuery(preset, "week"),
      },
      {
        name: `buildTrendsQuery(${preset}, hour)`,
        sql: buildTrendsQuery(preset, "hour"),
      },
      {
        name: `buildTokensTotalsQuery(${preset})`,
        sql: buildTokensTotalsQuery(preset),
      },
      {
        name: `buildTokensBySessionTypeQuery(${preset})`,
        sql: buildTokensBySessionTypeQuery(preset),
      },
      {
        name: `buildTokensByAgentQuery(${preset})`,
        sql: buildTokensByAgentQuery(preset),
      },
      {
        name: `buildTokensTrendsQuery(${preset})`,
        sql: buildTokensTrendsQuery(preset),
      },
    );
  }
  return out;
}

const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;

if (!apiKey) {
  const inCi = process.env.CI ?? process.env.SHIPWRIGHT_CI;
  if (inCi) {
    console.error(
      "ERROR: POSTHOG_PERSONAL_API_KEY is not set — required in CI. " +
        "Add it as a repository secret named POSTHOG_PERSONAL_API_KEY.",
    );
  } else {
    console.error(
      "ERROR: POSTHOG_PERSONAL_API_KEY is not set.\n" +
        "Set a read-only PostHog personal API key for project <your-project-id> to validate before deploy:\n" +
        "  POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=<your-project-id> bun run validate:hogql",
    );
  }
  process.exit(1);
}

const projectId = process.env.POSTHOG_PROJECT_ID;

if (!projectId) {
  console.error(
    "ERROR: POSTHOG_PROJECT_ID is not set.\n" +
      "Set the PostHog project ID for HogQL validation:\n" +
      "  POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=<your-project-id> bun run validate:hogql",
  );
  process.exit(1);
}

const client = createPostHogClient({ personalApiKey: apiKey, projectId });

const builders = allBuilders();
console.log(
  `Validating ${builders.length} HogQL queries via PostHog HogQLMetadata (project ${projectId})...`,
);

let failures = 0;
for (const { name, sql } of builders) {
  const result = await client.validate(sql);
  if (!result.isValid) {
    failures++;
    for (const err of result.errors) {
      console.error(`FAIL  ${name}: ${err.message}`);
    }
  } else {
    console.log(`  ok  ${name}`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} builder(s) failed HogQL validation. Fix before deploying.`,
  );
  process.exit(1);
}

console.log(`\nAll ${builders.length} HogQL queries valid.`);

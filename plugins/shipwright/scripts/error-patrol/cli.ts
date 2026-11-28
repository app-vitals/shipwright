#!/usr/bin/env bun
/**
 * error-scan helper: `bun cli.ts --repo org/repo --map MAP.json --prior PRIOR.json`
 * prints the recorder result JSON ({outcome, metrics, machineState, findings}).
 * MAP.json = ProjectRepoMap; PRIOR.json = the `findings` array from
 * `cron-run-recorder.ts prior`. Reads SENTRY_ORG / SENTRY_AUTH_TOKEN from env.
 */
import { readFileSync } from "node:fs";
import { scanRepo } from "./repo-filter.ts";

export function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (import.meta.main) {
  const repo = arg(process.argv, "repo");
  const mapPath = arg(process.argv, "map");
  const priorPath = arg(process.argv, "prior");
  const org = process.env.SENTRY_ORG;
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!repo || !mapPath || !org || !token) {
    console.error(
      "Usage: cli.ts --repo org/repo --map MAP.json [--prior PRIOR.json] (needs SENTRY_ORG, SENTRY_AUTH_TOKEN)",
    );
    process.exit(2);
  }
  const result = await scanRepo(
    { fetchFn: fetch, org, token },
    {
      repo,
      projectRepoMap: JSON.parse(readFileSync(mapPath, "utf8")),
      prior: priorPath ? JSON.parse(readFileSync(priorPath, "utf8")) : [],
    },
  );
  console.log(JSON.stringify(result));
}

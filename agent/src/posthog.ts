/**
 * Forward shipwright metrics.jsonl entries to PostHog.
 *
 * Dev-task writes metrics reliably via the Write tool (not Bash), so we forward
 * them from the cron handler rather than relying on Claude to run posthog_send.py.
 *
 * Usage:
 *   const snapshot = snapshotMetrics(workspace);
 *   await runner(message);
 *   await forwardNewMetrics(workspace, snapshot);
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage } from "./claude.ts";
import { liveClaudeConfig } from "./claude.ts";

interface MetricsEntry {
  task?: string;
  title?: string;
  session?: string;
  repo?: string;
  estimated_h?: number | null;
  pr?: number | null;
  files_changed?: number;
  started_at?: string;
  ts?: string;
  simplify?: Record<string, number>;
  requirements?: Record<string, number>;
  ci?: { fix_attempts?: number; failures?: string[] };
  [key: string]: unknown;
}

// All paths where dev-task may write metrics.jsonl, relative to workspace root.
// The model writes to inconsistent paths depending on how it interprets the session
// field, so we scan the known candidates rather than relying on a single path.
function metricsFilePaths(workspace: string): string[] {
  const paths: string[] = [
    join(workspace, "state", "metrics.jsonl"),
    join(workspace, "planning", "metrics.jsonl"),
  ];

  // Also pick up planning/{session}/metrics.jsonl
  const planningDir = join(workspace, "planning");
  if (existsSync(planningDir)) {
    try {
      for (const entry of readdirSync(planningDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          paths.push(join(planningDir, entry.name, "metrics.jsonl"));
        }
      }
    } catch {
      // Non-fatal — scan failure just means we miss subdirectory entries
    }
  }

  return paths;
}

/** Read current line counts for all metrics files. Call before running Claude. */
export function snapshotMetrics(workspace: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const path of metricsFilePaths(workspace)) {
    if (!existsSync(path)) continue;
    try {
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      snapshot.set(path, lines.length);
    } catch {
      // If we can't read it before, treat as 0 so we forward everything after
      snapshot.set(path, 0);
    }
  }
  return snapshot;
}

/**
 * Read any lines appended since the snapshot, parse them as MetricsEntry objects,
 * and POST them to PostHog as `shipwright_task_complete` events.
 *
 * Exits silently if POSTHOG_PROJECT_API_KEY is absent or PostHog is unreachable —
 * metrics are best-effort and must never fail a cron run.
 */
export async function forwardNewMetrics(
  workspace: string,
  snapshot: Map<string, number>,
): Promise<void> {
  const apiKey = process.env.POSTHOG_PROJECT_API_KEY;
  if (!apiKey) return;

  const entries: MetricsEntry[] = [];

  for (const path of metricsFilePaths(workspace)) {
    if (!existsSync(path)) continue;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim());
    } catch {
      continue;
    }

    const prevCount = snapshot.get(path) ?? 0;
    for (const line of lines.slice(prevCount)) {
      try {
        entries.push(JSON.parse(line) as MetricsEntry);
      } catch {
        // Skip malformed lines
      }
    }
  }

  if (entries.length === 0) return;

  const host = (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(
    /\/$/,
    "",
  );

  const batch = entries.map((entry) => ({
    event: "shipwright_task_complete",
    distinct_id: `shipwright/${entry.repo ?? "unknown"}/${entry.task ?? "unknown"}`,
    timestamp: entry.ts ?? new Date().toISOString(),
    properties: {
      $insert_id: `shipwright_task_complete/${entry.repo ?? "unknown"}/${entry.task ?? "unknown"}`,
      ...entry,
    },
  }));

  try {
    const res = await fetch(`${host}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, batch }),
    });
    if (!res.ok) {
      console.warn(
        `[agent:posthog] batch POST failed: ${res.status} — ${entries.length} event(s) dropped`,
      );
    } else {
      console.log(
        `[agent:posthog] forwarded ${entries.length} metrics event(s) to PostHog`,
      );
    }
  } catch (err) {
    // PostHog is best-effort — never propagate to the caller
    console.warn(
      `[agent:posthog] batch POST error: ${(err as Error).message} — ${entries.length} event(s) dropped`,
    );
  }
}

type SessionType = "slack_dm" | "slack_mention" | "cron";

/**
 * Forward token usage data to PostHog as an `agent_token_usage` event.
 *
 * Best-effort — never throws, never blocks the caller.
 * No-op when POSTHOG_PROJECT_API_KEY is absent or usage is undefined.
 */
export async function forwardTokenUsage(
  usage: TokenUsage | undefined,
  sessionType: SessionType,
  model?: string,
): Promise<void> {
  if (!usage) return;
  const apiKey = process.env.POSTHOG_PROJECT_API_KEY;
  if (!apiKey) return;

  const agentId = process.env.SHIPWRIGHT_AGENT_ID ?? "unknown";
  const resolvedModel = model ?? liveClaudeConfig.model;
  const ts = new Date().toISOString();
  const host = (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(
    /\/$/,
    "",
  );

  const event = {
    event: "agent_token_usage",
    distinct_id: `agent/${agentId}`,
    timestamp: ts,
    properties: {
      $insert_id: `agent_token_usage/${agentId}/${ts}`,
      agent_id: agentId,
      session_type: sessionType,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      model: resolvedModel,
    },
  };

  try {
    const res = await fetch(`${host}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, batch: [event] }),
    });
    if (!res.ok) {
      console.warn(`[agent:posthog] token usage POST failed: ${res.status}`);
    }
  } catch (err) {
    // PostHog is best-effort — never propagate to the caller
    console.warn(
      `[agent:posthog] token usage POST error: ${(err as Error).message}`,
    );
  }
}

#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/slack-say.ts
 *
 * One-line way for any skill to post a progress message into the Slack
 * thread its run was started from.
 *
 * Resolution order for channel/thread: CLI flag, then env
 * (SLACK_CHANNEL_ID, SLACK_THREAD_TS). Auth token is env-only
 * (SLACK_BOT_TOKEN) — there is no flag for it, on purpose.
 *
 * Behaviour:
 *   - No token or no channel resolved → write the text to stdout, exit 0.
 *   - Slack non-2xx or `ok:false` → write one stderr line naming Slack's
 *     `error` string, exit 0.
 *   - Success → exit 0 silently.
 * Never throws to the caller — this is a best-effort progress ping, not a
 * step whose failure should ever fail the calling skill.
 *
 * Usage:
 *   bun run ${CLAUDE_PLUGIN_ROOT}/scripts/slack-say.ts [--channel C] [--thread T] "text"
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The minimal shape this script needs from `fetch` — narrower than the full
 * Fetch API `Response` so tests can stub it with a plain object literal
 * instead of constructing a real `Response`.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface Deps {
  fetch: FetchLike;
  env: (name: string) => string | undefined;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface SlackSayResult {
  exit: 0;
}

interface ParsedArgs {
  channel?: string;
  thread?: string;
  text: string;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
}

// ─── Argument parsing ───────────────────────────────────────────────────────

/**
 * Parses `[--channel C] [--thread T] "text"` — flags may appear in either
 * order/position; every non-flag token is joined with a space to form the
 * message text (so an unquoted multi-word message still works).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let channel: string | undefined;
  let thread: string | undefined;
  const textParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--channel") {
      channel = argv[++i];
    } else if (arg === "--thread") {
      thread = argv[++i];
    } else {
      textParts.push(arg);
    }
  }

  return { channel, thread, text: textParts.join(" ") };
}

// ─── Core logic ───────────────────────────────────────────────────────────────

function describeSlackError(
  status: number,
  response: SlackApiResponse,
): string {
  if (response.error) return response.error;
  return `http_${status}`;
}

export async function postSlackSay(
  deps: Deps,
  argv: string[],
): Promise<SlackSayResult> {
  const { channel: flagChannel, thread: flagThread, text } = parseArgs(argv);

  const token = deps.env("SLACK_BOT_TOKEN");
  const channel = flagChannel ?? deps.env("SLACK_CHANNEL_ID");
  const thread = flagThread ?? deps.env("SLACK_THREAD_TS");

  if (!token || !channel) {
    deps.stdout(`${text}\n`);
    return { exit: 0 };
  }

  const body: Record<string, unknown> = {
    channel,
    text,
    mrkdwn: true,
    unfurl_links: false,
  };
  if (thread) body.thread_ts = thread;

  try {
    const res = await deps.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    let parsed: SlackApiResponse = {};
    try {
      parsed = (await res.json()) as SlackApiResponse;
    } catch {
      parsed = {};
    }

    if (!res.ok || !parsed.ok) {
      deps.stderr(
        `slack-say: chat.postMessage failed: ${describeSlackError(res.status, parsed)}\n`,
      );
      return { exit: 0 };
    }

    return { exit: 0 };
  } catch (err) {
    deps.stderr(`slack-say: chat.postMessage failed: ${String(err)}\n`);
    return { exit: 0 };
  }
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: (name: string) => process.env[name],
    stdout: (chunk: string) => {
      process.stdout.write(chunk);
    },
    stderr: (chunk: string) => {
      process.stderr.write(chunk);
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = buildProductionDeps();
  const result = await postSlackSay(deps, process.argv.slice(2));
  process.exit(result.exit);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(0);
  });
}

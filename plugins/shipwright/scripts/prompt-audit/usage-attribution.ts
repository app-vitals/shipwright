/**
 * plugins/shipwright/scripts/prompt-audit/usage-attribution.ts
 *
 * Skill usage for the prompt audit, from two sources. Both yield `SkillStat`
 * rows shaped like the admin `bySkill` dimension:
 *   - local `~/.claude/projects` transcripts, attributed with the same rules
 *     as agent/src/run-telemetry.ts (duplicated by design: the plugin is
 *     self-contained and cannot import from agent/). Last-wins: a `Skill`
 *     tool_use switches the bucket, turns carrying `parent_tool_use_id` go to
 *     `agent:<subagent_type>`, turns before any invoke go to `root`.
 *   - `fetchCronSkillStats`, the admin `GET /agents/all/cron-runs/stats`
 *     `bySkill` rows. Unreachable or malformed → null; never throws.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillStat {
  kind: string;
  name: string;
  runs: number;
  invocations: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  avgInvokeContextDelta: number | null;
}

export interface TranscriptFs {
  /** Absolute paths of every `*.jsonl` transcript under `root`. */
  listTranscripts(root: string): string[];
  readFile(path: string): string;
}

export const DEFAULT_PROJECTS_ROOT = join(homedir(), ".claude", "projects");

export const nodeTranscriptFs: TranscriptFs = {
  listTranscripts(root) {
    const out: string[] = [];
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const f of readdirSync(join(root, project.name))) {
        if (f.endsWith(".jsonl")) out.push(join(root, project.name, f));
      }
    }
    return out;
  },
  readFile: (path) => readFileSync(path, "utf8"),
};

interface Bucket {
  stat: SkillStat;
  awaitingDelta: boolean;
  deltaSum: number;
  deltaCount: number;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** Attribute one session's transcript lines to per-(kind, name) buckets. */
function attributeSession(
  text: string,
  buckets: Map<string, Bucket>,
  seenInSession: Set<string>,
): void {
  const bucket = (kind: string, name: string): Bucket => {
    const key = `${kind}:${name}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        stat: {
          kind,
          name,
          runs: 0,
          invocations: 0,
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          avgInvokeContextDelta: null,
        },
        awaitingDelta: false,
        deltaSum: 0,
        deltaCount: 0,
      };
      buckets.set(key, b);
    }
    if (!seenInSession.has(key)) {
      seenInSession.add(key);
      b.stat.runs += 1;
    }
    return b;
  };

  const seenToolUse = new Set<string>();
  const seenMessages = new Set<string>();
  const deltaTaken = new Set<string>();
  const subagentByToolUse = new Map<string, string>();
  let current = bucket("root", "root");
  // Only keep the root bucket if it ends up charged (matches the accumulator).
  const rootKey = "root:root";

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const message = event.message as Json | undefined;
    if (event.type !== "assistant" || !message) continue;

    for (const block of (message.content as Json[] | undefined) ?? []) {
      const id = block.id;
      if (block.type !== "tool_use" || typeof id !== "string") continue;
      if (seenToolUse.has(id)) continue;
      seenToolUse.add(id);
      const input = (block.input as Json | undefined) ?? {};
      if (block.name === "Skill" && typeof input.skill === "string") {
        if (input.skill.length === 0) continue;
        current = bucket("skill", input.skill);
        current.stat.invocations += 1;
        if (!deltaTaken.has(current.stat.name)) current.awaitingDelta = true;
      } else if (block.name === "Agent") {
        const t = input.subagent_type;
        const type = typeof t === "string" && t.length > 0 ? t : "unknown";
        subagentByToolUse.set(id, type);
        bucket("agent", type).stat.invocations += 1;
      }
    }

    const usage = message.usage as Json | undefined;
    const messageId = message.id;
    if (!usage || typeof messageId !== "string") continue;
    if (seenMessages.has(messageId)) continue;
    seenMessages.add(messageId);

    const parent = event.parent_tool_use_id;
    const target =
      typeof parent === "string"
        ? bucket("agent", subagentByToolUse.get(parent) ?? "unknown")
        : current;
    const input = num(usage.input_tokens);
    const creation = num(usage.cache_creation_input_tokens);
    target.stat.turns += 1;
    target.stat.input += input;
    target.stat.output += num(usage.output_tokens);
    target.stat.cacheRead += num(usage.cache_read_input_tokens);
    target.stat.cacheCreation += creation;
    if (target.awaitingDelta) {
      target.deltaSum += input + creation;
      target.deltaCount += 1;
      target.awaitingDelta = false;
      deltaTaken.add(target.stat.name);
    }
  }

  for (const b of buckets.values()) b.awaitingDelta = false;
  // A session that never produced a root turn must not count as a root run.
  const root = buckets.get(rootKey);
  if (root && root.stat.turns === 0) {
    buckets.delete(rootKey);
  }
}

/**
 * Parse transcripts (one JSONL string per session) into aggregated stats.
 * `runs` counts the sessions in which a bucket appeared.
 */
export function attributeTranscripts(sessions: string[]): SkillStat[] {
  const buckets = new Map<string, Bucket>();
  for (const text of sessions) attributeSession(text, buckets, new Set());
  return [...buckets.values()].map(({ stat, deltaSum, deltaCount }) => ({
    ...stat,
    avgInvokeContextDelta: deltaCount > 0 ? deltaSum / deltaCount : null,
  }));
}

/**
 * Local usage from `~/.claude/projects`. Missing/unreadable root or files
 * yield `null` (root) or are skipped (single file) — never throws.
 */
export function readLocalSkillStats(
  deps: { root?: string; fs?: TranscriptFs } = {},
): SkillStat[] | null {
  const fs = deps.fs ?? nodeTranscriptFs;
  try {
    const sessions: string[] = [];
    for (const path of fs.listTranscripts(deps.root ?? DEFAULT_PROJECTS_ROOT)) {
      try {
        sessions.push(fs.readFile(path));
      } catch {
        // unreadable transcript: skip
      }
    }
    return attributeTranscripts(sessions);
  } catch {
    return null;
  }
}

/**
 * `bySkill` rows from the admin stats endpoint. Returns null when env is
 * missing, the request fails or is non-2xx, or the body has no `bySkill`
 * array (older admin build).
 */
export async function fetchCronSkillStats(
  deps: { fetchFn?: typeof fetch; from?: string; to?: string } = {},
): Promise<SkillStat[] | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const apiUrl = (process.env.SHIPWRIGHT_API_URL ?? "").trim();
  const apiKey = (process.env.SHIPWRIGHT_AGENT_API_KEY ?? "").trim();
  if (!apiUrl || !apiKey) return null;

  const params = new URLSearchParams();
  if (deps.from) params.set("from", deps.from);
  if (deps.to) params.set("to", deps.to);
  const qs = params.size > 0 ? `?${params}` : "";
  try {
    const res = await fetchFn(
      `${apiUrl.replace(/\/$/, "")}/agents/all/cron-runs/stats${qs}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { bySkill?: unknown };
    return Array.isArray(body.bySkill) ? (body.bySkill as SkillStat[]) : null;
  } catch {
    return null;
  }
}

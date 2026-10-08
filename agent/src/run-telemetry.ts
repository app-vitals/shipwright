/**
 * agent/src/run-telemetry.ts
 *
 * Per-run measurement derived from the Claude CLI's `stream-json` events,
 * accumulated incrementally by `claude.ts`'s `_consumeStream` alongside the
 * existing per-model usage map. Three things are captured:
 *
 *   1. **First-turn context baseline** — the usage of the first `assistant`
 *      message. `input + cache_creation + cache_read` of that turn is the
 *      full context the model saw before any work happened (system prompt,
 *      tool schemas, always-loaded CLAUDE.md/rules, the skill listing, the
 *      cron prompt). Summing all three makes the number independent of cache
 *      warmth: a warm prefix cache just moves tokens from `cache_creation`
 *      to `cache_read`. It is the measured, per-model cost of the agent's
 *      always-loaded markdown — the number the prompt-audit patrol compares
 *      before/after a CLAUDE.md change.
 *   2. **Turn and tool-call counts** — distinct usage-bearing message ids and
 *      distinct `tool_use` block ids.
 *   3. **Per-skill attribution** — which plugin skills were invoked (the
 *      `Skill` tool), how often, and the tokens of every turn that ran while
 *      that skill was the most recently invoked one. Attribution is
 *      deterministic and last-wins: a skill's body stays in the conversation
 *      for the rest of the session, so every later turn is charged to the
 *      most recent invoke until another skill is invoked. Turns before any
 *      invoke accrue to the `root` bucket. Sub-agent turns (events carrying
 *      `parent_tool_use_id`) are charged to an `agent:<subagent_type>`
 *      bucket and never change the current skill.
 *
 * Pure accumulator — no I/O. The same event shapes appear in Claude Code's
 * transcript JSONL, so the accumulator can also replay a saved transcript.
 */

import type { ContentBlock } from "./progress-milestones.ts";

export interface FirstTurnUsage {
  model: string;
  messageId: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** input + cacheCreation + cacheRead — the full context at turn 1. */
  contextTokens: number;
}

export type AttributionKind = "skill" | "agent" | "root";

export interface SkillUsageRow {
  kind: AttributionKind;
  /** Skill name as invoked (e.g. "shipwright:task-store"), subagent type, or "root". */
  name: string;
  /** Distinct Skill/Agent tool_use blocks that invoked this name. 0 for root. */
  invocations: number;
  /** Usage-bearing turns charged to this bucket. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * `input + cache_creation` of the first usage-bearing turn after this
   * skill's first invoke — the new context admitted at that turn, which is
   * dominated by the skill body just loaded. Null until that turn arrives,
   * and always null for root/agent buckets.
   */
  invokeContextDelta: number | null;
}

export interface RunTelemetry {
  firstTurn?: FirstTurnUsage;
  turns: number;
  toolCalls: number;
  skillUsage: SkillUsageRow[];
}

/** Minimal usage shape shared by stream-json and transcript lines. */
export interface TurnUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Bucket extends SkillUsageRow {
  awaitingInvokeDelta: boolean;
}

function bucketKey(kind: AttributionKind, name: string): string {
  return `${kind}:${name}`;
}

function newBucket(kind: AttributionKind, name: string): Bucket {
  return {
    kind,
    name,
    invocations: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    invokeContextDelta: null,
    awaitingInvokeDelta: false,
  };
}

function toolUseInput(block: ContentBlock): Record<string, unknown> {
  const input = (block as { input?: unknown }).input;
  return input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

export class RunTelemetryAccumulator {
  private firstTurn: FirstTurnUsage | undefined;
  private turns = 0;
  private readonly seenToolUseIds = new Set<string>();
  private readonly buckets = new Map<string, Bucket>();
  /** Bucket key the next non-subagent usage-bearing turn is charged to. */
  private current = bucketKey("root", "root");
  /** Agent tool_use id → subagent type, for `parent_tool_use_id` lookups. */
  private readonly subagentByToolUseId = new Map<string, string>();

  constructor() {
    this.buckets.set(this.current, newBucket("root", "root"));
  }

  /**
   * Observe an assistant message's content blocks. Safe to call on every
   * stream line, including repeats of the same message id — tool_use blocks
   * are deduped by their own id.
   */
  observeContent(blocks: ContentBlock[] | undefined): void {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const id = (block as { id?: unknown }).id;
      if (typeof id !== "string" || this.seenToolUseIds.has(id)) continue;
      this.seenToolUseIds.add(id);

      const name = (block as { name?: unknown }).name;
      if (name === "Skill") {
        const skill = toolUseInput(block).skill;
        if (typeof skill === "string" && skill.length > 0) {
          const key = bucketKey("skill", skill);
          const bucket = this.ensureBucket("skill", skill);
          bucket.invocations += 1;
          if (bucket.invokeContextDelta === null)
            bucket.awaitingInvokeDelta = true;
          this.current = key;
        }
      } else if (name === "Agent") {
        const subagent = toolUseInput(block).subagent_type;
        const type =
          typeof subagent === "string" && subagent.length > 0
            ? subagent
            : "unknown";
        this.subagentByToolUseId.set(id, type);
        this.ensureBucket("agent", type).invocations += 1;
      }
    }
  }

  /**
   * Observe a usage-bearing assistant turn. The caller dedupes by message id
   * (same contract as `_consumeStream`'s per-model accumulation).
   */
  observeUsage(
    messageId: string,
    model: string,
    usage: TurnUsageLike,
    parentToolUseId?: string,
  ): void {
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;

    this.turns += 1;
    if (this.firstTurn === undefined && parentToolUseId === undefined) {
      this.firstTurn = {
        model,
        messageId,
        inputTokens: input,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        contextTokens: input + cacheCreation + cacheRead,
      };
    }

    const bucket =
      parentToolUseId !== undefined
        ? this.ensureBucket(
            "agent",
            this.subagentByToolUseId.get(parentToolUseId) ?? "unknown",
          )
        : (this.buckets.get(this.current) ?? this.ensureBucket("root", "root"));

    bucket.turns += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    bucket.cacheReadTokens += cacheRead;
    bucket.cacheCreationTokens += cacheCreation;
    if (bucket.awaitingInvokeDelta) {
      bucket.invokeContextDelta = input + cacheCreation;
      bucket.awaitingInvokeDelta = false;
    }
  }

  get toolCalls(): number {
    return this.seenToolUseIds.size;
  }

  snapshot(): RunTelemetry {
    const skillUsage: SkillUsageRow[] = [];
    for (const {
      awaitingInvokeDelta: _pending,
      ...row
    } of this.buckets.values()) {
      // Drop an untouched root bucket so a run that never produced a turn
      // reports an empty attribution list rather than a zero row.
      if (row.kind === "root" && row.turns === 0) continue;
      skillUsage.push({ ...row });
    }
    return {
      ...(this.firstTurn !== undefined && { firstTurn: { ...this.firstTurn } }),
      turns: this.turns,
      toolCalls: this.toolCalls,
      skillUsage,
    };
  }

  private ensureBucket(kind: AttributionKind, name: string): Bucket {
    const key = bucketKey(kind, name);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = newBucket(kind, name);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}

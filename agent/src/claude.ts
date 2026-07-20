import type { ErrorCapturingClient } from "@shipwright/lib/sentry";

export interface LiveClaudeConfig {
  model: string;
  fallbackModel?: string;
  effortLevel?: string;
  allowedTools: string[];
}

/**
 * Live Claude configuration — reads from process.env directly.
 * Updated at runtime by setLiveClaudeConfig (e.g. from agent config polling).
 */
export const liveClaudeConfig: LiveClaudeConfig = {
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  fallbackModel: process.env.ANTHROPIC_FALLBACK_MODEL,
  effortLevel: process.env.ANTHROPIC_EFFORT_LEVEL,
  allowedTools: process.env.AGENT_ALLOWED_TOOLS
    ? JSON.parse(process.env.AGENT_ALLOWED_TOOLS)
    : [],
};

export function setLiveClaudeConfig(patch: Partial<LiveClaudeConfig>): void {
  Object.assign(liveClaudeConfig, patch);
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Per-model token usage entry, as emitted by the Claude CLI's `modelUsage`
 * map (camelCase) — distinct from the snake_case top-level `usage` shape.
 */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  webSearchRequests?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Per-model token usage map: model name → ModelUsageEntry. */
export type ModelUsage = Record<string, ModelUsageEntry>;

export interface ClaudeRunResult {
  result: string;
  sessionId?: string;
  usage?: TokenUsage;
  totalCostUsd?: number;
  modelUsage?: ModelUsage;
  recoveredFromError?: boolean;
  /**
   * True when the stream ended cleanly (no process error) but never emitted a
   * terminal `result` event. In that case `result` is empty and `modelUsage`
   * carries whatever per-model usage was accumulated from the `assistant`
   * lines (costUSD unknown → 0), rather than throwing all of it away.
   */
  streamIncomplete?: boolean;
}

/**
 * Callback fired as each new assistant turn/message completes (a new distinct
 * `message.id` is observed), receiving the running accumulated per-model total.
 * The passed map is a fresh snapshot — safe to retain without it mutating.
 */
export type ProgressCallback = (modelUsage: ModelUsage) => void;

/**
 * Returns the model name with the highest outputTokens from the CLI's
 * modelUsage map. Returns undefined when the map is empty.
 */
export function dominantModel(modelUsage: ModelUsage): string | undefined {
  let best: string | undefined;
  let bestTokens = -1;
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (usage.outputTokens > bestTokens) {
      bestTokens = usage.outputTokens;
      best = model;
    }
  }
  return best;
}

/**
 * The terminal `result` stream event. Its fields are byte-identical in shape to
 * what the old `--output-format json` single-blob mode returned, plus the
 * stream discriminator (`type`/`subtype`).
 */
interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  result: string;
  session_id: string;
  is_error: boolean;
  api_error_status?: number;
  usage?: TokenUsage;
  total_cost_usd?: number;
  modelUsage?: ModelUsage;
}

/** One `assistant` stream event — carries a turn's usage keyed by message id. */
interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    id: string;
    role?: string;
    model?: string;
    usage?: TokenUsage;
  };
}

export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly apiErrorStatus: number | undefined,
    readonly resultMessage: string,
    readonly sessionId: string | undefined,
    /** Accumulated per-model usage at the point of failure, if any. */
    readonly modelUsage?: ModelUsage,
  ) {
    super(message);
    this.name = "ClaudeRunError";
  }
}

export class ClaudeTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    /** Per-model usage accumulated before the process was killed, if any. */
    readonly modelUsage?: ModelUsage,
  ) {
    super(`Claude session timed out after ${timeoutMs / 1000}s`);
    this.name = "ClaudeTimeoutError";
  }
}

interface ClaudeSessionStore {
  get: (key: string) => Promise<string | undefined> | string | undefined;
  set: (key: string, id: string) => Promise<void> | void;
  clear?: (key: string) => Promise<void> | void;
}

/**
 * Create a claude CLI runner.
 *
 * Default parameter values:
 *  - workspace: process.cwd() — caller should inject the real workspace path
 *  - sessions: no-op store — caller should inject a real createFileSessionStore instance
 *  - model: undefined — falls back to liveClaudeConfig.model
 */
export function createRunClaude(
  spawner: typeof Bun.spawn = Bun.spawn,
  sessions: ClaudeSessionStore = { get: () => undefined, set: () => {} },
  model: string | undefined = undefined,
  workspace: string = process.cwd(),
  sentryClient?: ErrorCapturingClient,
  extraAllowedTools: string[] | undefined = undefined,
  fallbackModel: string | undefined = undefined,
  effortLevel: string | undefined = undefined,
  timeoutMs: number = 30 * 60 * 1000,
  onProgress: ProgressCallback | undefined = undefined,
): (message: string, sessionKey?: string) => Promise<ClaudeRunResult> {
  // Per-session queue: ensures messages on the same thread run serially
  const sessionQueues = new Map<string, Promise<unknown>>();

  function _enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionQueues.get(key) ?? Promise.resolve();
    const next = prev
      .then(
        () => fn(),
        () => fn(),
      )
      .finally(() => {
        if (sessionQueues.get(key) === next) sessionQueues.delete(key);
      });
    sessionQueues.set(key, next);
    return next as Promise<T>;
  }

  function _buildArgs(
    message: string,
    resumeSessionId: string | undefined,
  ): string[] {
    const resolvedModel = model ?? liveClaudeConfig.model;
    const resolvedFallbackModel =
      fallbackModel ?? liveClaudeConfig.fallbackModel;
    const resolvedEffortLevel = effortLevel ?? liveClaudeConfig.effortLevel;
    const resolvedExtraAllowedTools =
      extraAllowedTools ?? liveClaudeConfig.allowedTools;

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebSearch",
      "WebFetch",
      "Skill",
      "Agent",
      "TodoWrite",
      ...resolvedExtraAllowedTools,
      "--model",
      resolvedModel,
      ...(resolvedFallbackModel
        ? ["--fallback-model", resolvedFallbackModel]
        : []),
      ...(resolvedEffortLevel ? ["--effort", resolvedEffortLevel] : []),
    ];

    if (resumeSessionId) {
      args.push("-r", resumeSessionId);
    }

    args.push(message);
    return args;
  }

  /** Deep-clone a ModelUsage map so callbacks get an immutable snapshot. */
  function _snapshotUsage(usage: ModelUsage): ModelUsage {
    const out: ModelUsage = {};
    for (const [model, entry] of Object.entries(usage)) {
      out[model] = { ...entry };
    }
    return out;
  }

  /**
   * Consume a stream-json NDJSON stdout stream incrementally, accumulating
   * per-model usage from `assistant` lines (deduped by message id) and
   * capturing the terminal `result` event if one arrives. Malformed / non-JSON
   * lines are skipped rather than aborting the whole parse.
   */
  async function _consumeStream(stream: ReadableStream<Uint8Array>): Promise<{
    result?: ClaudeResultEvent;
    modelUsage: ModelUsage;
    raw: string;
  }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const accumulated: ModelUsage = {};
    const seenMessageIds = new Set<string>();
    let result: ClaudeResultEvent | undefined;
    let buffer = "";
    let raw = "";

    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // skip stray non-JSON lines without losing prior accumulation
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as { type?: string };

      if (event.type === "result") {
        result = parsed as ClaudeResultEvent;
        return;
      }
      if (event.type !== "assistant") return; // ignore system/user/etc.

      const { message } = parsed as ClaudeAssistantEvent;
      if (!message?.id || !message.usage) return;
      if (seenMessageIds.has(message.id)) return; // dedupe repeated turn lines
      seenMessageIds.add(message.id);

      const model = message.model ?? "unknown";
      let entry = accumulated[model];
      if (!entry) {
        entry = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0, // authoritative cost is only known from the result event
        };
        accumulated[model] = entry;
      }
      entry.inputTokens += message.usage.input_tokens ?? 0;
      entry.outputTokens += message.usage.output_tokens ?? 0;
      entry.cacheReadInputTokens += message.usage.cache_read_input_tokens ?? 0;
      entry.cacheCreationInputTokens +=
        message.usage.cache_creation_input_tokens ?? 0;

      onProgress?.(_snapshotUsage(accumulated));
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      const tail = decoder.decode();
      raw += tail;
      buffer += tail;
      handleLine(buffer); // trailing line without a newline
    } finally {
      reader.releaseLock();
    }

    return { result, modelUsage: accumulated, raw };
  }

  async function _spawn(args: string[]): Promise<ClaudeRunResult> {
    const proc = spawner(["claude", ...args], {
      cwd: workspace,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    const [{ result, modelUsage, raw }, stderr, exitCode] = await Promise.all([
      _consumeStream(proc.stdout),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));

    if (timedOut) {
      throw new ClaudeTimeoutError(timeoutMs, modelUsage);
    }

    if (exitCode !== 0) {
      if (result?.is_error) {
        throw new ClaudeRunError(
          `claude exited ${exitCode}: api_error_status=${result.api_error_status ?? "unknown"} ${result.result}`,
          result.api_error_status,
          result.result,
          result.session_id,
          result.modelUsage ?? modelUsage,
        );
      }
      // A truncated stream that still carried some usage: surface it on the
      // error rather than discarding it.
      if (Object.keys(modelUsage).length > 0) {
        throw new ClaudeRunError(
          `claude exited ${exitCode}: ${stderr.trim() || "stream truncated"}`,
          undefined,
          result?.result ?? "",
          result?.session_id,
          modelUsage,
        );
      }
      throw new Error(
        `claude exited ${exitCode}: ${stderr.trim() || raw.trim()}`,
      );
    }

    if (!result) {
      // Clean exit, but the stream ended without a terminal result event.
      // Surface the accumulated partial usage via a distinct return shape
      // instead of throwing everything away.
      return {
        result: "",
        modelUsage,
        streamIncomplete: true,
      };
    }
    if (result.is_error) {
      throw new ClaudeRunError(
        `claude error: ${result.result}`,
        result.api_error_status,
        result.result,
        result.session_id,
        result.modelUsage ?? modelUsage,
      );
    }

    return {
      result: result.result,
      sessionId: result.session_id,
      usage: result.usage,
      totalCostUsd: result.total_cost_usd,
      modelUsage: result.modelUsage,
    };
  }

  async function _saveSession(
    sessionKey: string | undefined,
    output: ClaudeRunResult,
  ) {
    if (sessionKey && output.sessionId) {
      await sessions.set(sessionKey, output.sessionId);
    }
  }

  async function _runClaude(
    message: string,
    sessionKey: string | undefined,
  ): Promise<ClaudeRunResult> {
    const existingSessionId = sessionKey
      ? await sessions.get(sessionKey)
      : undefined;

    const args = _buildArgs(message, existingSessionId);

    try {
      const output = await _spawn(args);
      await _saveSession(sessionKey, output);
      return output;
    } catch (err) {
      // Retry the same resumed session once: transient blips (e.g. a socket
      // close) can self-heal on a second attempt without losing conversation
      // context. Do NOT catch ClaudeTimeoutError — that means the session
      // hung and we should surface the error rather than silently spawning a
      // second process that would also hang. If the retry also fails,
      // rethrow the ORIGINAL error and leave the session mapping untouched —
      // an error (even a burst of them) is never treated as proof the
      // session itself is corrupt.
      if (existingSessionId && !(err instanceof ClaudeTimeoutError)) {
        try {
          const output = await _spawn(args);
          await _saveSession(sessionKey, output);
          return { ...output, recoveredFromError: true };
        } catch {
          sentryClient?.captureException(err);
          throw err;
        }
      }
      throw err;
    }
  }

  return async function runClaude(
    message: string,
    sessionKey?: string,
  ): Promise<ClaudeRunResult> {
    if (sessionKey)
      return _enqueue(sessionKey, () => _runClaude(message, sessionKey));
    return _runClaude(message, undefined);
  };
}

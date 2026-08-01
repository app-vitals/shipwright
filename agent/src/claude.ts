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

/**
 * The unconditional tool floor granted to every Claude session, regardless of
 * what's seeded in the AgentTool DB table. These are read-only or
 * context-only tools with no meaningful security delta from Read (which is
 * already assumed safe) — they are permanently non-revocable.
 *
 * Bash, WebSearch, WebFetch, and Agent are deliberately NOT included here:
 * they now flow entirely through `liveClaudeConfig.allowedTools` /
 * `extraAllowedTools`, sourced from the AgentTool DB table (seeded at agent
 * creation from the resolved Agent Type manifest — see
 * agent-types/coding/manifest.yaml and admin/src/agents-api.ts — and
 * backfilled for existing agents). This is the capability-narrowing step: an
 * agent with no AgentTool rows (or a 404'd config bundle) no longer gets
 * Bash/WebSearch/WebFetch/Agent for free.
 */
export const FLOOR_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "TodoWrite",
  "Skill",
];

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
   *
   * Caveat: this accumulated `modelUsage` (and the partial usage attached to
   * `ClaudeTimeoutError`/`ClaudeRunError`) undercounts `outputTokens`. Each
   * `assistant` line's `usage.output_tokens` only reflects *visible* output —
   * extended-thinking tokens are billed as output but often come back with an
   * empty/redacted `thinking` field, so they never show up in that per-line
   * total. Only the terminal `result` event's `modelUsage` is authoritative;
   * treat any partial/incomplete usage as a lower bound, not a true count.
   * Confirmed against real `claude -p --output-format stream-json --verbose`
   * captures during CSU-1.1 validation — see anthropics/claude-code#27361 and
   * #64153.
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

/** Which timer fired: idle-reset (no stdout activity) or the hard ceiling. */
export type ClaudeTimeoutReason = "idle" | "ceiling";

export class ClaudeTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    /** Which limit fired — idle-reset timer or the hard ceiling. */
    readonly reason: ClaudeTimeoutReason = "ceiling",
    /**
     * Per-model usage accumulated before the process was killed, if any.
     * Always partial by definition — a clean finish never reaches this path.
     */
    readonly partialModelUsage?: ModelUsage,
    /**
     * The session id captured off the leading `system`/`init` stream-json
     * line, if one arrived before the timeout fired. A timed-out run never
     * reaches a terminal `result` event (the only other source of a session
     * id), so this is the only way a timeout can still carry one.
     */
    readonly sessionId?: string,
  ) {
    super(`Claude session timed out after ${timeoutMs / 1000}s (${reason})`);
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
  /**
   * Idle-reset timeout: cleared and restarted on every stdout line. Fires
   * when the process goes silent for this long, even if `timeoutMs` (the
   * hard ceiling) hasn't elapsed yet. Default 25min.
   */
  idleTimeoutMs: number = 25 * 60 * 1000,
  onProgress: ProgressCallback | undefined = undefined,
): (
  message: string,
  sessionKey?: string,
  onProgress?: ProgressCallback,
) => Promise<ClaudeRunResult> {
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

    // Deduplicate tools: Set preserves insertion order, so first-occurrence wins
    const deduplicatedTools = [
      ...new Set([...FLOOR_TOOLS, ...resolvedExtraAllowedTools]),
    ];

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...deduplicatedTools,
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
  async function _consumeStream(
    stream: ReadableStream<Uint8Array>,
    onLine?: () => void,
    perCallOnProgress?: ProgressCallback,
  ): Promise<{
    result?: ClaudeResultEvent;
    modelUsage: ModelUsage;
    raw: string;
    sessionId?: string;
  }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const accumulated: ModelUsage = {};
    const seenMessageIds = new Set<string>();
    let result: ClaudeResultEvent | undefined;
    let buffer = "";
    let raw = "";
    // Captured off the very first `system`/`init` line, if one arrives — the
    // earliest point in the stream a session id is ever available. Populated
    // once and never overwritten, so a stray later system line (there's never
    // more than one `init` per run in practice) can't clobber it.
    let earlySessionId: string | undefined;

    const handleLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      onLine?.();
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
      if (event.type === "system") {
        const system = parsed as {
          subtype?: string;
          session_id?: string;
        };
        if (
          earlySessionId === undefined &&
          system.subtype === "init" &&
          system.session_id
        ) {
          earlySessionId = system.session_id;
        }
        return;
      }
      if (event.type !== "assistant") return; // ignore user/etc.

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
      // NOTE: message.usage.output_tokens excludes extended-thinking tokens
      // (billed as output, but the thinking content is often redacted before
      // it reaches this line) — this accumulation undercounts true output
      // tokens whenever the `result` event isn't reached. See the
      // `streamIncomplete` doc comment above for the full explanation.
      entry.outputTokens += message.usage.output_tokens ?? 0;
      entry.cacheReadInputTokens += message.usage.cache_read_input_tokens ?? 0;
      entry.cacheCreationInputTokens +=
        message.usage.cache_creation_input_tokens ?? 0;

      // Fire both the construction-time-bound closure (kept for back-compat)
      // and the per-call callback (if provided), each with its own snapshot
      // so neither can mutate what the other observes.
      onProgress?.(_snapshotUsage(accumulated));
      perCallOnProgress?.(_snapshotUsage(accumulated));
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

    return { result, modelUsage: accumulated, raw, sessionId: earlySessionId };
  }

  async function _spawn(
    args: string[],
    perCallOnProgress?: ProgressCallback,
  ): Promise<ClaudeRunResult> {
    // Strip SENTRY_DSN so a spawned Claude Code session (and any `bun test`
    // it runs internally) can never construct a real Sentry client from
    // ambient env — this is not the agent's own operational Sentry
    // reporting (see the reportCronFailure / captureException call sites),
    // which runs in this parent process against its own client, unaffected
    // by the child's env.
    const { SENTRY_DSN: _sentryDsn, ...spawnEnv } = process.env;
    const proc = spawner(["claude", ...args], {
      cwd: workspace,
      env: spawnEnv,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    let timeoutReason: ClaudeTimeoutReason = "ceiling";
    let firedTimeoutMs = timeoutMs;

    // Hard ceiling: set once, never reset. Backstops a continuously-active
    // but never-converging session (idle timer alone would never fire).
    const ceilingTimer = setTimeout(() => {
      timedOut = true;
      timeoutReason = "ceiling";
      firedTimeoutMs = timeoutMs;
      proc.kill();
    }, timeoutMs);

    // Idle-reset timer: cleared/restarted on every stdout line. Fires when
    // the process goes silent, even with ceiling headroom remaining.
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        timeoutReason = "idle";
        firedTimeoutMs = idleTimeoutMs;
        proc.kill();
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    const [
      { result, modelUsage, raw, sessionId: earlySessionId },
      stderr,
      exitCode,
    ] = await Promise.all([
      _consumeStream(proc.stdout, resetIdleTimer, perCallOnProgress),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => {
      clearTimeout(ceilingTimer);
      clearTimeout(idleTimer);
    });

    if (timedOut) {
      throw new ClaudeTimeoutError(
        firedTimeoutMs,
        timeoutReason,
        modelUsage,
        earlySessionId,
      );
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
        const diagnostic = stderr.trim() || "stream truncated";
        throw new ClaudeRunError(
          `claude exited ${exitCode}: ${diagnostic}`,
          undefined,
          diagnostic,
          result?.session_id ?? earlySessionId,
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
        sessionId: earlySessionId,
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

  /**
   * Persist whatever session id a FAILED attempt still managed to capture.
   * ClaudeRunError/ClaudeTimeoutError can both carry a `sessionId` — the CLI
   * may have already created a real session (and transcript file) before
   * erroring or timing out. Without this, a first-message failure leaves
   * `sessions` empty even though a resumable session exists, so the next
   * reply on the same Slack thread starts a brand-new, context-free session
   * instead of resuming. Purely a side effect — never affects control flow.
   */
  async function _saveSessionFromError(
    sessionKey: string | undefined,
    err: unknown,
  ) {
    if (!sessionKey) return;
    if (!(err instanceof ClaudeRunError || err instanceof ClaudeTimeoutError))
      return;
    if (err.sessionId) {
      await sessions.set(sessionKey, err.sessionId);
    }
  }

  async function _runClaude(
    message: string,
    sessionKey: string | undefined,
    perCallOnProgress: ProgressCallback | undefined,
  ): Promise<ClaudeRunResult> {
    const existingSessionId = sessionKey
      ? await sessions.get(sessionKey)
      : undefined;

    const args = _buildArgs(message, existingSessionId);

    try {
      const output = await _spawn(args, perCallOnProgress);
      await _saveSession(sessionKey, output);
      return output;
    } catch (err) {
      // The initial attempt failed — save whatever session id it captured
      // before deciding whether to retry, so even a non-retried (or
      // retry-ineligible) failure still leaves a resumable mapping behind.
      try {
        await _saveSessionFromError(sessionKey, err);
      } catch {
        // Best-effort persistence — a failed write here must never mask or
        // replace the original Claude error being handled in this catch block.
      }

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
          const output = await _spawn(args, perCallOnProgress);
          await _saveSession(sessionKey, output);
          return { ...output, recoveredFromError: true };
        } catch (retryErr) {
          // The retry also failed — overwrite with its own most-recently-known
          // session id (if any), then still rethrow the ORIGINAL error.
          try {
            await _saveSessionFromError(sessionKey, retryErr);
          } catch {
            // Best-effort persistence — a failed write here must never mask
            // the original error or prevent the Sentry capture/rethrow below.
          }
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
    onProgress?: ProgressCallback,
  ): Promise<ClaudeRunResult> {
    if (sessionKey)
      return _enqueue(sessionKey, () =>
        _runClaude(message, sessionKey, onProgress),
      );
    return _runClaude(message, undefined, onProgress);
  };
}

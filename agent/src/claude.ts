import type { AnalyticsEvent } from "./analytics.ts";

type Tracker = (event: Omit<AnalyticsEvent, "timestamp">) => void;
const noopTracker: Tracker = () => {};

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

interface ClaudeJsonOutput {
  result: string;
  session_id: string;
  is_error: boolean;
  api_error_status?: number;
  usage?: TokenUsage;
}

export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly apiErrorStatus: number | undefined,
    readonly resultMessage: string,
    readonly sessionId: string | undefined,
  ) {
    super(message);
    this.name = "ClaudeRunError";
  }
}

export class ClaudeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Claude session timed out after ${timeoutMs / 1000}s`);
    this.name = "ClaudeTimeoutError";
  }
}

interface ClaudeSessionStore {
  get: (key: string) => string | undefined;
  set: (key: string, id: string) => void;
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
  tracker: Tracker = noopTracker,
  extraAllowedTools: string[] | undefined = undefined,
  fallbackModel: string | undefined = undefined,
  effortLevel: string | undefined = undefined,
  timeoutMs: number = 30 * 60 * 1000,
): (
  message: string,
  sessionKey?: string,
) => Promise<{ result: string; sessionId?: string; usage?: TokenUsage }> {
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
      "json",
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

  function _tryParseJson(stdout: string): ClaudeJsonOutput | undefined {
    try {
      return JSON.parse(stdout) as ClaudeJsonOutput;
    } catch {
      return undefined;
    }
  }

  async function _spawn(
    args: string[],
  ): Promise<{ result: string; sessionId?: string; usage?: TokenUsage }> {
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

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));

    if (timedOut) {
      throw new ClaudeTimeoutError(timeoutMs);
    }

    const structured = _tryParseJson(stdout);
    if (exitCode !== 0) {
      if (structured?.is_error) {
        throw new ClaudeRunError(
          `claude exited ${exitCode}: api_error_status=${structured.api_error_status ?? "unknown"} ${structured.result}`,
          structured.api_error_status,
          structured.result,
          structured.session_id,
        );
      }
      throw new Error(
        `claude exited ${exitCode}: ${stderr.trim() || stdout.trim()}`,
      );
    }

    if (!structured) {
      throw new Error(
        `claude returned non-JSON stdout: ${stdout.slice(0, 200)}`,
      );
    }
    if (structured.is_error) {
      throw new ClaudeRunError(
        `claude error: ${structured.result}`,
        structured.api_error_status,
        structured.result,
        structured.session_id,
      );
    }

    return {
      result: structured.result,
      sessionId: structured.session_id,
      usage: structured.usage,
    };
  }

  async function _runClaude(
    message: string,
    sessionKey: string | undefined,
  ): Promise<{ result: string; sessionId?: string; usage?: TokenUsage }> {
    const existingSessionId = sessionKey ? sessions.get(sessionKey) : undefined;

    if (sessionKey && !existingSessionId) {
      tracker({ type: "session_start", sessionKey });
    }

    const args = _buildArgs(message, existingSessionId);

    try {
      const output = await _spawn(args);
      if (sessionKey && output.sessionId) {
        sessions.set(sessionKey, output.sessionId);
      }
      return output;
    } catch (err) {
      // Stale session fallback: if resume failed, clear the dead session
      // and retry fresh so the user gets a response instead of an error.
      // Do NOT catch ClaudeTimeoutError — that means the session hung and
      // we should surface the error rather than silently spawning a second
      // process that would also hang.
      if (existingSessionId && !(err instanceof ClaudeTimeoutError)) {
        const fallbackStart = Date.now();
        if (sessionKey && "clear" in sessions) {
          (sessions as { clear: (key: string) => void }).clear(sessionKey);
        }
        const freshArgs = _buildArgs(message, undefined);
        const output = await _spawn(freshArgs);
        tracker({
          type: "session_fallback",
          sessionKey,
          durationMs: Date.now() - fallbackStart,
        });
        if (sessionKey && output.sessionId) {
          sessions.set(sessionKey, output.sessionId);
        }
        return output;
      }
      throw err;
    }
  }

  return async function runClaude(
    message: string,
    sessionKey?: string,
  ): Promise<{ result: string; sessionId?: string; usage?: TokenUsage }> {
    if (sessionKey)
      return _enqueue(sessionKey, () => _runClaude(message, sessionKey));
    return _runClaude(message, undefined);
  };
}

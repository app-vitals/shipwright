/**
 * lib/progress-phases.ts
 * The closed set of generic progress phases derived from a Claude Code
 * `stream-json` session (see `agent/src/progress-milestones.ts`), plus their
 * human-readable labels. Consumed by `agent/src/claude.ts`'s `ProgressCallback`
 * and, eventually, by UI surfaces that want to show "what is the agent doing
 * right now" without exposing raw tool inputs (which may contain secrets or
 * file paths).
 */

/** The closed set of generic progress phases a Claude stream can report. */
export type ProgressPhase =
  | "starting"
  | "thinking"
  | "reading"
  | "searching"
  | "web"
  | "editing"
  | "running"
  | "delegating"
  | "planning"
  | "tool"
  | "writing";

/** Runtime-checkable list of every valid ProgressPhase, in a stable order. */
export const PROGRESS_PHASES: readonly ProgressPhase[] = [
  "starting",
  "thinking",
  "reading",
  "searching",
  "web",
  "editing",
  "running",
  "delegating",
  "planning",
  "tool",
  "writing",
];

/**
 * Short human-readable label per phase, for eventual UI use. Every label
 * ends in an ellipsis ("…") — they describe an *in-progress* action (e.g.
 * a Slack Thinking Steps card mid-run), and a bare label like "Reading
 * files" reads as already-completed rather than ongoing.
 */
export const PROGRESS_LABELS: Record<ProgressPhase, string> = {
  starting: "Starting up…",
  thinking: "Thinking…",
  reading: "Reading files…",
  searching: "Searching the codebase…",
  web: "Searching the web…",
  editing: "Editing files…",
  running: "Running commands…",
  delegating: "Delegating to a subagent…",
  planning: "Planning…",
  tool: "Using a tool…",
  writing: "Writing a response…",
};

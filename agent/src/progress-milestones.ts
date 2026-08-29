/**
 * agent/src/progress-milestones.ts
 * Maps a single `content` block from an `assistant` `stream-json` message to
 * a generic `ProgressPhase` (see `@shipwright/lib/progress-phases`).
 *
 * LOAD-BEARING INVARIANT: `block.input` is never read here — not logged, not
 * inspected, not passed to any function. Tool inputs can carry absolute
 * filesystem paths, secrets, command lines, or URLs; none of that may ever
 * leave the agent process via this code path. Phase is derived from
 * `block.type` and `block.name` (the tool name) ONLY. Do not add any code
 * here that touches `block.input`.
 */

import type { ProgressPhase } from "@shipwright/lib/progress-phases";

/**
 * The shape of one entry in an `assistant` message's `content` array, as
 * emitted by `claude -p --output-format stream-json --verbose`. `input` is
 * intentionally typed as `unknown` and MUST NOT be read by this module — see
 * the file-level invariant above.
 */
export interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  /** Other block-type-specific fields (e.g. `thinking`, `text`) — never read. */
  [key: string]: unknown;
}

/** Tool names (exact match) mapped to their progress phase. */
const TOOL_PHASE_MAP: Record<string, ProgressPhase> = {
  // Reading: pulling in a known file's full contents.
  Read: "reading",
  NotebookRead: "reading",
  // Searching: looking for something across the codebase by pattern/name,
  // distinct from "reading" a specific known file.
  Grep: "searching",
  Glob: "searching",
  // Web: leaving the local filesystem/codebase entirely.
  WebSearch: "web",
  WebFetch: "web",
  // Editing: mutating files.
  Edit: "editing",
  Write: "editing",
  NotebookEdit: "editing",
  // Running: shell/process execution.
  Bash: "running",
  KillShell: "running",
  BashOutput: "running",
  // Delegating: dispatching work to a subagent.
  Agent: "delegating",
  Task: "delegating",
  // Planning: todo/plan-mode bookkeeping tools.
  TodoWrite: "planning",
  ExitPlanMode: "planning",
  EnterPlanMode: "planning",
};

/** Prefix for any MCP-provided tool — always falls back to the generic phase. */
const MCP_TOOL_PREFIX = "mcp__";

/** Generic fallback phase for any tool_use block whose name isn't recognized. */
const GENERIC_TOOL_PHASE: ProgressPhase = "tool";

/**
 * Resolve the ProgressPhase for a single `assistant` content block. Returns
 * `undefined` for block types this module doesn't map (e.g. `tool_result`,
 * which only ever appears in `user` messages and is out of scope here).
 *
 * Never throws and never returns `undefined` for a `tool_use` block,
 * regardless of tool name — new tools are added over time, so an unrecognized
 * name always falls back to the generic `"tool"` phase rather than being
 * dropped.
 */
export function phaseForBlock(block: ContentBlock): ProgressPhase | undefined {
  switch (block.type) {
    case "thinking":
      return "thinking";
    case "text":
      return "writing";
    case "tool_use": {
      const name = block.name ?? "";
      if (name in TOOL_PHASE_MAP) return TOOL_PHASE_MAP[name];
      if (name.startsWith(MCP_TOOL_PREFIX)) return GENERIC_TOOL_PHASE;
      return GENERIC_TOOL_PHASE;
    }
    default:
      return undefined;
  }
}

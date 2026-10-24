/**
 * plugins/shipwright/scripts/prompt-audit/eval-graders.ts
 *
 * Grader specs and their on-disk form (evals/<case>/graders/*.md), in the
 * format `claude plugin eval` loads: a markdown file with YAML frontmatter
 * (`type: regex|tool_used|llm|...`). Mechanical (code) graders come first:
 * tool_used and transcript_contains map to `tool_used` and `regex` graders.
 * `tests_pass` and `task_store_state` have no mechanical equivalent in plugin
 * eval (runs are isolated from the task store and `gh`, and there is no repo
 * to run tests in), so they are DROPPED when cases are written, with a logged
 * reason (see `unsupportedReason`). An LLM judge is allowed only from a
 * different model family than the generator.
 */

export type Grader =
  | {
      type: "tool_used";
      tool: "Skill";
      skill: string;
      expect: "present" | "absent";
    }
  | { type: "tests_pass"; command: string }
  | {
      type: "task_store_state";
      taskId: string;
      field: string;
      expected: string;
    }
  | { type: "transcript_contains"; text: string }
  | { type: "llm_judge"; model: string; rubric: string };

/** Model family: first segment of the id, after any provider prefix. */
export function modelFamily(model: string): string {
  const base = model.split("/").pop() ?? model;
  return base.split(/[-.:]/)[0].toLowerCase();
}

export function assertJudgeFamily(generator: string, judge: string): void {
  if (modelFamily(generator) === modelFamily(judge)) {
    throw new Error(
      `LLM judge ${judge} must be from a different family than generator ${generator}`,
    );
  }
}

export function graderName(g: Grader, index: number): string {
  return `${String(index + 1).padStart(2, "0")}-${g.type}.md`;
}

/** Mechanical graders are everything except llm_judge. */
export function isMechanical(g: Grader): boolean {
  return g.type !== "llm_judge";
}

/** Graders `claude plugin eval` cannot express; dropped at write time. */
export function unsupportedReason(g: Grader): string | undefined {
  switch (g.type) {
    case "tests_pass":
      return "tests_pass has no plugin-eval equivalent (no repo checkout to run tests in)";
    case "task_store_state":
      return "task_store_state has no plugin-eval equivalent (runs are isolated from the task store)";
    default:
      return undefined;
  }
}

export const escapeRegex = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** YAML single-quoted scalar: only `'` needs escaping, backslashes are literal. */
const yq = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function renderGrader(g: Grader): string {
  switch (g.type) {
    case "tool_used": {
      const match = `"skill"\\s*:\\s*"(?:shipwright:)?${escapeRegex(g.skill)}"`;
      const count = g.expect === "present" ? "min: 1" : "min: 0\nmax: 0";
      return `---\ntype: tool_used\ntool: ${g.tool}\ninput_match: ${yq(match)}\n${count}\n---\n\nSkill ${g.skill} must be ${g.expect === "present" ? "invoked" : "not invoked"}.\n`;
    }
    case "transcript_contains":
      // last_message, not trace: the trace includes the user prompt, which
      // names the step, so a trace regex would pass vacuously.
      return `---\ntype: regex\ntarget: last_message\npattern: ${yq(escapeRegex(g.text))}\n---\n\nFinal message mentions the step "${g.text.replace(/\s+/g, " ")}".\n`;
    case "llm_judge":
      return `---\ntype: llm\nweight: 1\n---\n\n${g.rubric}\n`;
    case "tests_pass":
    case "task_store_state":
      throw new Error(`cannot render ${g.type}: ${unsupportedReason(g)}`);
  }
}

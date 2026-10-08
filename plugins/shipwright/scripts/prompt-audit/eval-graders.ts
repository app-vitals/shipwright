/**
 * plugins/shipwright/scripts/prompt-audit/eval-graders.ts
 *
 * Grader specs and their on-disk form (evals/<case>/graders/*.md). Mechanical
 * (code) graders come first: tool_used, tests_pass, task_store_state and
 * transcript_contains. An LLM judge is allowed only from a different model
 * family than the generator.
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

export function renderGrader(g: Grader): string {
  switch (g.type) {
    case "tool_used":
      return `# Grader: tool_used\n\ntool_used: ${g.tool}\nskill: ${g.skill}\nexpect: ${g.expect}\n`;
    case "tests_pass":
      return `# Grader: tests_pass\n\ncommand: ${g.command}\nexpect: exit 0\n`;
    case "task_store_state":
      return `# Grader: task_store_state\n\ntask: ${g.taskId}\nfield: ${g.field}\nexpected: ${g.expected}\n`;
    case "transcript_contains":
      return `# Grader: transcript_contains\n\nrequired step in transcript: ${g.text}\n`;
    case "llm_judge":
      return `# Grader: llm_judge\n\nmodel: ${g.model}\nrubric: ${g.rubric}\n`;
  }
}

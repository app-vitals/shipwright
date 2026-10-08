/**
 * plugins/shipwright/scripts/prompt-audit/eval-cases.ts
 *
 * Frozen eval case builder. Cases are derived from the command's own steps
 * (trigger sets: should / shouldn't prompts with a tool_used: Skill grader)
 * plus replayable historical tasks (repo reset to the pre-task commit,
 * outcome hidden). Purely synthetic cases are smoke only. The same cases run
 * in every arm (paired) with >= MIN_SEEDS seeds. Output is deterministic.
 */

import { createHash } from "node:crypto";
import { MIN_SEEDS } from "./eval-cost.ts";
import {
  assertJudgeFamily,
  type Grader,
  graderName,
  renderGrader,
} from "./eval-graders.ts";
import type { Finding } from "./finding.ts";

export const MIN_CASES = 20;
export const MAX_CASES = 30;

export interface HistoricalTask {
  id: string;
  /** Prompt with the outcome hidden. */
  prompt: string;
  preTaskCommit: string;
  testCommand?: string;
  expectedState?: { field: string; expected: string };
}

export interface EvalCase {
  id: string;
  kind: "trigger-should" | "trigger-shouldnt" | "step" | "historical";
  prompt: string;
  graders: Grader[];
  /** Synthetic cases are smoke tests, not quality evidence. */
  smoke: boolean;
  /** Repo checkout to reset to before the run (historical cases only). */
  resetTo?: string;
  seeds: number;
}

export interface CaseDeps {
  fs: { read(root: string, rel: string): string };
  write(root: string, rel: string, content: string): void;
  historical?: HistoricalTask[];
  judge?: { generator: string; model: string; rubric: string };
}

const SHOULDNT = [
  "Summarise the open issues in this repository.",
  "Rename a local variable in src/index.ts.",
  "Explain how the build cache works.",
  "Write a unit test for an unrelated helper.",
  "Format all markdown files with the repo formatter.",
  "List the current git branches.",
  "What does the README say about installation?",
  "Bump the patch version in package.json.",
  "Draft release notes for the last tag.",
  "Find TODO comments in the source tree.",
];

const TRIGGER_TEMPLATES = [
  "Please {step}.",
  "I need you to {step}; go ahead.",
  "Can you {step} for me?",
  "Kick off: {step}.",
  "Walk through and execute: {step}.",
  "Time to {step}.",
  "Use the right tooling to {step}.",
  "Handle this now: {step}.",
];

/** Step headings (## / ###) of a command file, minus numbering noise. */
export function extractSteps(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^#{2,3}\s+(?:Step\s+)?(.+?)\s*$/.exec(line);
    if (m && !/^(arguments?|notes?)$/i.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

export function skillNameOf(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base === "SKILL.md"
    ? (file.split("/").slice(-2, -1)[0] ?? base)
    : base.replace(/\.md$/, "");
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
const hash = (s: string) =>
  createHash("sha1").update(s).digest("hex").slice(0, 8);

function mk(c: Omit<EvalCase, "id" | "seeds">): EvalCase {
  return {
    ...c,
    id: `${c.kind}-${slug(c.prompt)}-${hash(c.prompt)}`,
    seeds: MIN_SEEDS,
  };
}

export function buildEvalCases(
  finding: Finding,
  repoDir: string,
  deps: CaseDeps,
): EvalCase[] {
  const skill = skillNameOf(finding.file);
  const steps = extractSteps(deps.fs.read(repoDir, finding.file));
  const cases: EvalCase[] = [];
  const hist = (deps.historical ?? []).slice(0, 10);
  for (const t of hist) {
    const graders: Grader[] = [];
    if (t.testCommand)
      graders.push({ type: "tests_pass", command: t.testCommand });
    if (t.expectedState) {
      graders.push({
        type: "task_store_state",
        taskId: t.id,
        ...t.expectedState,
      });
    }
    graders.push({
      type: "tool_used",
      tool: "Skill",
      skill,
      expect: "present",
    });
    cases.push({
      ...mk({ kind: "historical", prompt: t.prompt, graders, smoke: false }),
      resetTo: t.preTaskCommit,
    });
  }
  const shouldCount =
    Math.max(
      MIN_CASES,
      Math.min(MAX_CASES, cases.length + steps.length * 2 + SHOULDNT.length),
    ) -
    cases.length -
    SHOULDNT.length;
  const subjects = steps.length ? steps : [skill];
  for (let i = 0; i < shouldCount; i++) {
    const step = subjects[i % subjects.length];
    const round = Math.floor(i / subjects.length);
    const tpl = TRIGGER_TEMPLATES[round % TRIGGER_TEMPLATES.length];
    const scenario =
      round >= TRIGGER_TEMPLATES.length ? ` (scenario ${round})` : "";
    const prompt =
      tpl.replace("{step}", `run the /${skill} step "${step}"`) + scenario;
    cases.push(
      mk({
        kind: "trigger-should",
        prompt,
        smoke: true,
        graders: [
          { type: "tool_used", tool: "Skill", skill, expect: "present" },
          { type: "transcript_contains", text: step },
        ],
      }),
    );
  }
  for (const p of SHOULDNT) {
    cases.push(
      mk({
        kind: "trigger-shouldnt",
        prompt: p,
        smoke: true,
        graders: [
          { type: "tool_used", tool: "Skill", skill, expect: "absent" },
        ],
      }),
    );
  }
  const uniq = [...new Map(cases.map((c) => [c.id, c])).values()].slice(
    0,
    MAX_CASES,
  );
  if (deps.judge) {
    assertJudgeFamily(deps.judge.generator, deps.judge.model);
    for (const c of uniq) {
      c.graders.push({
        type: "llm_judge",
        model: deps.judge.model,
        rubric: deps.judge.rubric,
      });
    }
  }
  return uniq;
}

/** Write evals/<case>/prompt.md and evals/<case>/graders/*.md. */
export function writeEvalCases(
  cases: EvalCase[],
  repoDir: string,
  deps: Pick<CaseDeps, "write">,
): void {
  for (const c of cases) {
    const dir = `evals/${c.id}`;
    deps.write(repoDir, `${dir}/prompt.md`, `${c.prompt}\n`);
    c.graders.forEach((g, i) => {
      deps.write(
        repoDir,
        `${dir}/graders/${graderName(g, i)}`,
        renderGrader(g),
      );
    });
  }
}

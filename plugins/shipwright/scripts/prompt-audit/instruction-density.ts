/**
 * plugins/shipwright/scripts/prompt-audit/instruction-density.ts
 *
 * Instruction-density analyzer for the prompt audit. Counts imperative
 * markers in a prompt file and reports how early the first hard constraint
 * appears. Pure text in, numbers out — no I/O.
 */

const IMPERATIVE_VERBS = [
  "run",
  "use",
  "create",
  "check",
  "write",
  "read",
  "add",
  "update",
  "fetch",
  "print",
  "stop",
  "send",
  "post",
  "mark",
  "set",
  "call",
  "dispatch",
  "fix",
  "ensure",
  "verify",
  "avoid",
  "do",
  "don't",
  "keep",
  "make",
  "pass",
  "emit",
  "record",
  "skip",
  "wait",
  "load",
  "parse",
  "return",
  "respond",
  "proceed",
];

const CAPS_EMPHASIS = /\b(?:MUST|NEVER|ALWAYS|CRITICAL)\b/g;
const HARD_CONSTRAINT = /\b(?:MUST|NEVER|ALWAYS|CRITICAL)\b/;
const NUMBERED_STEP = /^\s*\d+[.)]\s+\S/;
const IMPERATIVE_LINE = new RegExp(
  `^\\s*(?:[-*]\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?(?:${IMPERATIVE_VERBS.join("|").replace(/'/g, "['’]")})\\b`,
  "i",
);
const BOLD_IMPERATIVE = new RegExp(
  `\\*\\*(?:${IMPERATIVE_VERBS.join("|").replace(/'/g, "['’]")}|(?:do not|must not))\\b[^*]*\\*\\*`,
  "gi",
);

export interface InstructionDensity {
  totalLines: number;
  nonBlankLines: number;
  imperatives: number;
  capsEmphasis: number;
  numberedSteps: number;
  boldImperatives: number;
  /** Instruction markers per non-blank line. */
  densityPerLine: number;
  /** 1-based line of the first hard constraint, or null when there is none. */
  firstHardConstraintLine: number | null;
  /** firstHardConstraintLine / nonBlank-or-total lines (0..1); null when none. */
  firstHardConstraintRatio: number | null;
}

/** Strip a leading YAML frontmatter block and fenced code, preserving line count. */
function maskNonProse(text: string): string[] {
  const lines = text.split("\n");
  let inFence = false;
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  return lines.map((line, i) => {
    if (i < start) return "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

export function analyzeInstructionDensity(text: string): InstructionDensity {
  const lines = maskNonProse(text);
  let nonBlank = 0;
  let imperatives = 0;
  let capsEmphasis = 0;
  let numberedSteps = 0;
  let boldImperatives = 0;
  let firstHard: number | null = null;

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    nonBlank++;
    if (IMPERATIVE_LINE.test(line)) imperatives++;
    if (NUMBERED_STEP.test(line)) numberedSteps++;
    capsEmphasis += line.match(CAPS_EMPHASIS)?.length ?? 0;
    boldImperatives += line.match(BOLD_IMPERATIVE)?.length ?? 0;
    if (firstHard === null && HARD_CONSTRAINT.test(line)) firstHard = i + 1;
  });

  const markers = imperatives + capsEmphasis + numberedSteps + boldImperatives;
  return {
    totalLines: lines.length,
    nonBlankLines: nonBlank,
    imperatives,
    capsEmphasis,
    numberedSteps,
    boldImperatives,
    densityPerLine: nonBlank === 0 ? 0 : markers / nonBlank,
    firstHardConstraintLine: firstHard,
    firstHardConstraintRatio:
      firstHard === null ? null : firstHard / lines.length,
  };
}

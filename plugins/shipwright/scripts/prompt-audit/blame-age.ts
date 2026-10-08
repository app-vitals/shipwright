/**
 * plugins/shipwright/scripts/prompt-audit/blame-age.ts
 *
 * Blame-age analyzer for the prompt audit. Runs `git blame --line-porcelain`
 * through an injected exec and reports how old a prompt file's lines are.
 */

const DAY_SECONDS = 86_400;

export type BlameExec = (cmd: string[]) => string;

export interface BlameAge {
  lines: number;
  maxAgeDays: number;
  medianAgeDays: number;
  /** The oldest line (earliest author-time); ties resolve to the lowest line number. */
  oldestLine: { line: number; ageDays: number } | null;
}

export interface BlameAgeDeps {
  exec: BlameExec;
  /** Current time in epoch seconds; injected for deterministic tests. */
  now: number;
}

/** Extract `[finalLine, authorTime]` pairs from `git blame --line-porcelain` output. */
export function parseBlamePorcelain(out: string): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  let line = 0;
  let time = 0;
  for (const l of out.split("\n")) {
    const header = l.match(/^[0-9a-f]{40} \d+ (\d+)(?: \d+)?$/);
    if (header) {
      line = Number(header[1]);
    } else if (l.startsWith("author-time ")) {
      time = Number(l.slice("author-time ".length));
    } else if (l.startsWith("\t")) {
      rows.push([line, time]);
    }
  }
  return rows;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analyzeBlameAge(
  file: string,
  { exec, now }: BlameAgeDeps,
): BlameAge {
  const rows = parseBlamePorcelain(
    exec(["git", "blame", "--line-porcelain", "--", file]),
  );
  if (rows.length === 0) {
    return { lines: 0, maxAgeDays: 0, medianAgeDays: 0, oldestLine: null };
  }
  const ages = rows.map(([line, t]) => ({
    line,
    ageDays: Math.max(0, (now - t) / DAY_SECONDS),
  }));
  const oldest = ages.reduce((a, b) =>
    b.ageDays > a.ageDays || (b.ageDays === a.ageDays && b.line < a.line)
      ? b
      : a,
  );
  const sorted = ages.map((a) => a.ageDays).sort((a, b) => a - b);
  return {
    lines: rows.length,
    maxAgeDays: oldest.ageDays,
    medianAgeDays: median(sorted),
    oldestLine: oldest,
  };
}

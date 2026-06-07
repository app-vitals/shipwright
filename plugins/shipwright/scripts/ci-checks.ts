export interface CiCheck {
  name: string;
  conclusion: string;
}

export interface ActionsJob {
  name: string;
  conclusion: string | null;
}

export function parseActionsChecks(jobs: ActionsJob[]): CiCheck[] {
  return jobs.map((job) => ({
    name: job.name,
    conclusion: job.conclusion ?? "",
  }));
}

export function groupChecksByName(checks: CiCheck[]): string {
  if (checks.length === 0) return "";

  const counts = new Map<string, number>();
  for (const check of checks) {
    counts.set(check.name, (counts.get(check.name) ?? 0) + 1);
  }

  // name ascending as tiebreaker for stable output
  const sorted = [...counts.entries()].sort((a, b) => {
    const freqDiff = b[1] - a[1];
    if (freqDiff !== 0) return freqDiff;
    return a[0].localeCompare(b[0]);
  });

  return sorted.map(([name, count]) => `${name} (${count}×)`).join(" | ");
}

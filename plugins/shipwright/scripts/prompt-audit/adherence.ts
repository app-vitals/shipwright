/**
 * plugins/shipwright/scripts/prompt-audit/adherence.ts
 *
 * Per-command step adherence for the prompt audit, from the admin
 * `GET /agents/all/cron-runs/dev-task-adherence` report (DTA-1.2). Only
 * dev-task has a required-steps table today, so only it carries a rate. A
 * command's rate is adherentRuns / runs: the share of runs where every
 * mandatory, dispatch-measurable step ran. Unreachable or malformed → null;
 * never throws.
 */

export interface CommandAdherence {
  command: string;
  runs: number;
  adherentRuns: number;
  /** adherentRuns / runs. */
  rate: number;
}

const COMMAND_FILE = /(?:^|\/)commands\/([^/]+)\.md$/;
const SKILL_FILE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/;

/** The command a prompt file belongs to, or null for files outside commands/skills. */
export function commandOfFile(path: string): string | null {
  return (COMMAND_FILE.exec(path) ?? SKILL_FILE.exec(path))?.[1] ?? null;
}

/** Adherence for dev-task from the admin report body; null when unusable or no runs. */
export function parseDevTaskAdherence(
  body: unknown,
): CommandAdherence[] | null {
  const overall = (body as { overall?: Record<string, unknown> } | null)
    ?.overall;
  const runs = overall?.runs;
  const adherentRuns = overall?.adherentRuns;
  if (typeof runs !== "number" || typeof adherentRuns !== "number") return null;
  if (runs <= 0) return [];
  return [
    { command: "dev-task", runs, adherentRuns, rate: adherentRuns / runs },
  ];
}

export async function fetchCommandAdherence(
  deps: { fetchFn?: typeof fetch; from?: string; to?: string } = {},
): Promise<CommandAdherence[] | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const apiUrl = (process.env.SHIPWRIGHT_API_URL ?? "").trim();
  const apiKey = (process.env.SHIPWRIGHT_AGENT_API_KEY ?? "").trim();
  if (!apiUrl || !apiKey) return null;

  const params = new URLSearchParams();
  if (deps.from) params.set("from", deps.from);
  if (deps.to) params.set("to", deps.to);
  const qs = params.size > 0 ? `?${params}` : "";
  try {
    const res = await fetchFn(
      `${apiUrl.replace(/\/$/, "")}/agents/all/cron-runs/dev-task-adherence${qs}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) return null;
    return parseDevTaskAdherence(await res.json());
  } catch {
    return null;
  }
}

/** Lowest rate first; ties by command name. */
export function rankAdherence(rows: CommandAdherence[]): CommandAdherence[] {
  return [...rows].sort(
    (a, b) => a.rate - b.rate || a.command.localeCompare(b.command),
  );
}

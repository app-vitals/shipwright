/**
 * Detects the installed Claude Code CLI version once at agent startup so it can
 * be logged and surfaced in /health. Fail-soft: any exec failure, non-semver
 * output, or timeout resolves to "unknown" — never throws, never blocks startup
 * beyond the bounded timeout.
 *
 * The exec is injected (no mock.module in tests); `bunExec` is the real one.
 */

export const UNKNOWN_CLAUDE_CODE_VERSION = "unknown";

/** Upper bound on how long `claude --version` may delay startup. */
export const CLAUDE_VERSION_TIMEOUT_MS = 5_000;

/** Runs a command and resolves to its stdout; rejects on non-zero exit. */
export type VersionExec = (cmd: string[]) => Promise<string>;

const SEMVER_RE = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;

/** Extracts the first semver from `claude --version` output (e.g. "2.1.236 (Claude Code)"). */
export function parseClaudeVersion(output: string): string | null {
  return SEMVER_RE.exec(output)?.[1] ?? null;
}

export async function detectClaudeCodeVersion(
  exec: VersionExec,
  timeoutMs: number = CLAUDE_VERSION_TIMEOUT_MS,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const output = await Promise.race([
      exec(["claude", "--version"]).catch(() => null),
      timeout,
    ]);
    if (output === null) return UNKNOWN_CLAUDE_CODE_VERSION;
    return parseClaudeVersion(output) ?? UNKNOWN_CLAUDE_CODE_VERSION;
  } catch {
    return UNKNOWN_CLAUDE_CODE_VERSION;
  } finally {
    clearTimeout(timer);
  }
}

export const bunExec: VersionExec = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with code ${code}`);
  return out;
};

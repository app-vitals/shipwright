/**
 * agent/src/runtime/gh-helpers.ts
 *
 * Generic `gh` CLI helpers (ghJson, ghRun, ghGraphql, getCurrentUser),
 * split out of check-helpers.ts (ARD-4.1). Runtime-side: no coding-domain
 * knowledge. check-helpers.ts re-exports these for existing importers.
 */

/**
 * Run a gh CLI command and return the parsed JSON output.
 * Throws on non-zero exit.
 */
export async function ghJson<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["gh", ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (exit ${status}): ${stderr}`);
  }
  return JSON.parse(stdout) as T;
}

/**
 * Run a gh CLI command without parsing output.
 * Throws on non-zero exit.
 */
export async function ghRun(args: string[]): Promise<void> {
  const proc = Bun.spawn(["gh", ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, status] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (exit ${status}): ${stderr}`);
  }
}

const GH_GRAPHQL_MAX_ATTEMPTS = 3;
const GH_GRAPHQL_BASE_DELAY_MS = 500;
const GH_TRANSIENT_STDERR = /HTTP 50[234]\b|timed? ?out/i;

/**
 * Run a gh API graphql command and return the raw response.
 *
 * Retries (exponential backoff) when gh fails with a transient gateway error
 * (HTTP 502/503/504 or a timeout). Any other failure — auth, query errors —
 * throws immediately. After exhausting retries the last error is thrown in
 * the same format as a non-retried failure.
 */
export async function ghGraphql<T>(
  query: string,
  opts: { baseDelayMs?: number } = {},
): Promise<T> {
  const baseDelayMs = opts.baseDelayMs ?? GH_GRAPHQL_BASE_DELAY_MS;
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawn(["gh", "api", "graphql", "-f", `query=${query}`], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (status === 0) {
      return JSON.parse(stdout) as T;
    }
    if (
      attempt >= GH_GRAPHQL_MAX_ATTEMPTS ||
      !GH_TRANSIENT_STDERR.test(stderr)
    ) {
      throw new Error(`gh api graphql failed (exit ${status}): ${stderr}`);
    }
    await Bun.sleep(baseDelayMs * 2 ** (attempt - 1));
  }
}

/**
 * Get the current authenticated GH user login.
 *
 * Uses GraphQL viewer (not REST /user) because installation tokens issued to
 * GitHub Apps are rejected by /user with 403; the viewer query resolves to the
 * app's bot identity under both PAT and installation-token auth.
 *
 * Normalises the bot identity format: GraphQL returns "name[bot]" but
 * pr.author.login (and gh pr list --author) use "app/name", so we convert
 * here once so every call-site sees a consistent format.
 */
export async function getCurrentUser(): Promise<string> {
  const result = await ghGraphql<{ data: { viewer: { login: string } } }>(
    "query { viewer { login } }",
  );
  const login = result.data.viewer.login;
  return login.endsWith("[bot]") ? `app/${login.slice(0, -5)}` : login;
}

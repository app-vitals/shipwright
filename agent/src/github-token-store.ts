/**
 * agent/src/github-token-store.ts
 *
 * File-based token storage for the GitHub App installation token.
 * Writes atomically (tmp → rename) with 0o600 permissions.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function resolveTokenPath(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.GH_TOKEN_FILE) return env.GH_TOKEN_FILE;
  if (env.XDG_RUNTIME_DIR) {
    return path.join(env.XDG_RUNTIME_DIR, "shipwright-agent-gh-token");
  }
  const home = env.HOME ?? "/tmp";
  return path.join(home, ".shipwright-agent-gh-token");
}

export function writeToken(
  token: string,
  tokenPath: string = resolveTokenPath(),
): void {
  const dir = path.dirname(tokenPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, tokenPath);
}

export function readToken(
  tokenPath: string = resolveTokenPath(),
): string | null {
  try {
    return fs.readFileSync(tokenPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

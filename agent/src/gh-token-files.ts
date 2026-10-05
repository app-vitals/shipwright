/**
 * agent/src/gh-token-files.ts
 *
 * Atomic token-file layer. `gh-token` always holds the default installation's
 * token; `gh-token.d/<lowercase-owner>` holds per-owner tokens only while two
 * or more installations are usable. Two processes (entrypoint-main and
 * index.ts) write the same files, so every write is temp file + rename —
 * readers never observe a torn file.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** GitHub owner (user/org) login: alphanumerics and single hyphens, max 39, no leading/trailing hyphen. */
const GITHUB_OWNER_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function validateOwner(owner: string): string {
  if (!GITHUB_OWNER_PATTERN.test(owner)) {
    throw new Error(`Invalid GitHub owner name: ${JSON.stringify(owner)}`);
  }
  return owner.toLowerCase();
}

/** Write via a unique temp file in the same directory, then rename over the target (mode 0600). */
export function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    chmodSync(tmp, 0o600); // mode above is masked by umask and ignored on overwrite
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export interface TokenFilesInput {
  /** Default installation's token — always written to `gh-token`. */
  defaultToken: string;
  /** Per-owner tokens for every usable installation (including the default's owner). */
  ownerTokens?: Record<string, string>;
}

/**
 * Write `gh-token` and, when two or more installations are usable, the
 * per-owner files. Otherwise remove stale per-owner entries and the directory.
 */
export function writeTokenFiles(agentHome: string, input: TokenFilesInput): void {
  const dir = join(agentHome, "gh-token.d");
  const owners = Object.entries(input.ownerTokens ?? {}).map(
    ([owner, token]) => [validateOwner(owner), token] as const,
  );

  writeFileAtomic(join(agentHome, "gh-token"), input.defaultToken);

  if (owners.length < 2) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [owner, token] of owners) writeFileAtomic(join(dir, owner), token);

  const keep = new Set(owners.map(([owner]) => owner));
  for (const name of readdirSync(dir)) {
    if (!keep.has(name) && !name.endsWith(".tmp")) {
      rmSync(join(dir, name), { force: true });
    }
  }
}

/**
 * agent/src/gh-owner-resolver.ts
 *
 * Resolves which GitHub owner (org/user) a `gh` invocation targets, so the
 * wrapper can pick the matching App installation token. Pure logic: the only
 * I/O (reading the cwd git remote) is injected as `exec`.
 *
 * Resolution order (first hit wins):
 *   1. -R / --repo / --repo=  (OWNER/REPO, HOST/OWNER/REPO, or URL)
 *   2. `gh api` path: repos/<owner>/..., /repos/<owner>/..., or the full API URL
 *   3. `gh repo clone` positional argument (OWNER/REPO or URL)
 *   4. cwd `origin` remote (repo-scoped commands only)
 *   5. the default owner
 *
 * A matched-but-invalid owner string falls back to the default rather than
 * continuing down the order — an explicit target we cannot trust must not be
 * silently replaced by a different owner's token.
 *
 * Kept in agent/src (not agent/scripts): the Dockerfile copies lib/ and src
 * into the runtime stage but not scripts/ for src imports.
 */

/** Runs a command in `cwd`, returning trimmed stdout; throws on failure. */
export type ExecFn = (cmd: string, args: string[], cwd: string) => string;

export interface ResolveGhOwnerOptions {
  defaultOwner: string;
  cwd?: string;
  exec?: ExecFn;
}

// GitHub logins: alphanumerics and single hyphens, no leading hyphen, <= 39 chars.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Commands whose target is not a repo, so the cwd remote says nothing about them.
const NOT_REPO_SCOPED = new Set([
  "api",
  "auth",
  "search",
  "config",
  "extension",
  "alias",
  "version",
  "help",
  "completion",
]);

const API_REPOS_RE =
  /^(?:https?:\/\/[^/]+\/(?:api\/v3\/)?|\/)?repos\/([^/]+)\//;
const REMOTE_RE = /github\.com[:/]([^/\s]+)\/[^/\s]+/;

function isValidOwner(owner: string | undefined): owner is string {
  return owner !== undefined && OWNER_RE.test(owner);
}

/** Owner from OWNER/REPO, HOST/OWNER/REPO, or a URL; undefined if unparseable. */
function ownerFromRepoRef(ref: string): string | undefined {
  const urlMatch = ref.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/([^/]+)\/[^/]+/i);
  if (urlMatch) return urlMatch[1];
  const parts = ref.split("/");
  if (parts.length === 2) return parts[0];
  if (parts.length === 3) return parts[1];
  return undefined;
}

function repoFlagValue(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") return undefined;
    if (arg === "-R" || arg === "--repo") return args[i + 1] ?? "";
    if (arg.startsWith("--repo=")) return arg.slice("--repo=".length);
  }
  return undefined;
}

function apiPathOwner(args: string[]): string | undefined {
  if (args[0] !== "api") return undefined;
  for (const arg of args.slice(1)) {
    const m = arg.match(API_REPOS_RE);
    if (m) return m[1];
  }
  return undefined;
}

function cloneTarget(args: string[]): string | undefined {
  if (args[0] !== "repo" || args[1] !== "clone") return undefined;
  const positional = args.slice(2).find((a) => !a.startsWith("-"));
  // A bare repo name has no owner; gh resolves it against the authed user.
  return positional?.includes("/") ? positional : undefined;
}

function remoteOwner(opts: ResolveGhOwnerOptions): string | undefined {
  if (!opts.exec || !opts.cwd) return undefined;
  try {
    const url = opts.exec("git", ["remote", "get-url", "origin"], opts.cwd);
    return url.match(REMOTE_RE)?.[1];
  } catch {
    return undefined;
  }
}

export function resolveGhOwner(
  args: string[],
  opts: ResolveGhOwnerOptions,
): string {
  const fallback = opts.defaultOwner;
  const check = (owner: string | undefined): string =>
    isValidOwner(owner) ? owner : fallback;

  const flag = repoFlagValue(args);
  if (flag !== undefined) return check(ownerFromRepoRef(flag));

  const apiOwner = apiPathOwner(args);
  if (apiOwner !== undefined) return check(apiOwner);

  const clone = cloneTarget(args);
  if (clone !== undefined) return check(ownerFromRepoRef(clone));

  if (args[0] !== undefined && !NOT_REPO_SCOPED.has(args[0])) {
    const fromRemote = remoteOwner(opts);
    if (fromRemote !== undefined) return check(fromRemote);
  }

  return fallback;
}

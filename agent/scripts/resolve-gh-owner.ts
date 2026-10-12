/**
 * agent/scripts/resolve-gh-owner.ts
 * Thin CLI over agent/src/gh-owner-resolver.ts — prints the GitHub owner a
 * `gh` invocation targets.
 *
 * Usage:
 *   bun agent/scripts/resolve-gh-owner.ts --default <owner> [--cwd <dir>] -- <gh args...>
 *
 * Prints the resolved owner on stdout. Always exits 0 once --default is given.
 */

import { execFileSync } from "node:child_process";
import { parseFlags } from "../../lib/cli-flags.ts";
import { resolveGhOwner } from "../src/gh-owner-resolver.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? argv : argv.slice(0, sep);
const ghArgs = sep === -1 ? [] : argv.slice(sep + 1);

const flags = parseFlags(own, ["--default", "--cwd"]);

const defaultOwner = flags["--default"];
if (!defaultOwner) {
  console.error("resolve-gh-owner: --default <owner> is required");
  process.exit(2);
}

const owner = resolveGhOwner(ghArgs, {
  defaultOwner,
  cwd: flags["--cwd"] ?? process.cwd(),
  exec: (cmd, args, cwd) =>
    execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
});
console.log(owner);

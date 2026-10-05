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
import { resolveGhOwner } from "../src/gh-owner-resolver.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep === -1 ? argv : argv.slice(0, sep);
const ghArgs = sep === -1 ? [] : argv.slice(sep + 1);

function flag(name: string): string | undefined {
  const i = own.indexOf(name);
  return i === -1 ? undefined : own[i + 1];
}

const defaultOwner = flag("--default");
if (!defaultOwner) {
  console.error("resolve-gh-owner: --default <owner> is required");
  process.exit(2);
}

const owner = resolveGhOwner(ghArgs, {
  defaultOwner,
  cwd: flag("--cwd") ?? process.cwd(),
  exec: (cmd, args, cwd) =>
    execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
});
console.log(owner);

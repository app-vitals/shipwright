/**
 * agent/scripts/cli-args.ts
 *
 * Pure CLI argument parsing helpers.
 * Reads from the provided argv array (not process.argv directly) so callers
 * control input — test-friendly by design.
 */

/**
 * Returns the value for --name=value or --name value in argv.
 * Returns undefined if the flag is absent or has no following value.
 */
export function getArg(name: string, argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    // --name=value form
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }

    // --name value form
    if (arg === name) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("-") ? next : undefined;
    }
  }
  return undefined;
}

/**
 * Returns true if --name is present anywhere in argv as an exact match.
 */
export function hasFlag(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

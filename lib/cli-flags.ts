/**
 * lib/cli-flags.ts
 * Generalized CLI flag parser: supports both `--flag value` and
 * `--flag=value` syntax. Generalizes `agent/src/cli-args.ts`'s narrow,
 * hand-rolled `parseCliArgs` (which only supports `--flag value` for exactly
 * three flags) so any script can declare the flags it cares about.
 *
 * Pure argv parsing — no env var fallback. Unknown flags (not declared in
 * `flagSpecs`) are silently ignored, matching `parseCliArgs`'s tolerant
 * behavior. Callers that want an env var fallback (see `parseCliArgs` for
 * that pattern) layer it on top of this helper's result.
 */

/** Parsed flag values, keyed by the exact flag string passed in `flagSpecs` (e.g. `"--agent-id"`). */
export type ParsedFlags<Flags extends readonly string[]> = Record<
  Flags[number],
  string | undefined
>;

/**
 * Parses `argv` for the flags declared in `flagSpecs`, supporting both
 * `--flag value` and `--flag=value` syntax. Flags not declared in
 * `flagSpecs` are ignored without error. A declared flag absent from `argv`
 * (or a `--flag value` form flag with no following value) resolves to
 * `undefined`.
 */
export function parseFlags<const Flags extends readonly string[]>(
  argv: readonly string[],
  flagSpecs: Flags,
): ParsedFlags<Flags> {
  const known = new Set<string>(flagSpecs);
  const result = {} as ParsedFlags<Flags>;
  for (const flag of flagSpecs) {
    result[flag as Flags[number]] = undefined;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const flag = arg.slice(0, eqIdx);
      if (known.has(flag)) {
        result[flag as Flags[number]] = arg.slice(eqIdx + 1);
      }
      continue;
    }

    if (known.has(arg)) {
      const value = argv[i + 1];
      if (value !== undefined) {
        result[arg as Flags[number]] = value;
        i++;
      }
    }
  }

  return result;
}

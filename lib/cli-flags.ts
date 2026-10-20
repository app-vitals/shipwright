/**
 * lib/cli-flags.ts
 * Generalized CLI flag parser: supports both `--flag value` and
 * `--flag=value` syntax. Generalizes `agent/src/runtime/cli-args.ts`'s narrow,
 * hand-rolled `parseCliArgs` (which only supports `--flag value` for exactly
 * three flags) so any script can declare the flags it cares about.
 *
 * Pure argv parsing — no env var fallback. Beyond string flags it supports
 * boolean (presence) flags and repeatable (multi-value) flags. Unknown flags (not declared in
 * `flagSpecs`) are silently ignored, matching `parseCliArgs`'s tolerant
 * behavior. Callers that want an env var fallback (see `parseCliArgs` for
 * that pattern) layer it on top of this helper's result.
 */

/** Parsed string-flag values, keyed by the exact flag string passed in `flagSpecs` (e.g. `"--agent-id"`). */
type ParsedFlags<Flags extends readonly string[]> = Record<
  Flags[number],
  string | undefined
>;

/** Optional flag kinds beyond the plain `--flag value` string flags. */
interface FlagKinds<
  Bools extends readonly string[],
  Multi extends readonly string[],
> {
  /** Presence-only flags: `true` when passed (bare, or `--flag=true`/`--flag=false`), else `false`. Never consume the next token. */
  booleans?: Bools;
  /** Repeatable value flags: every occurrence is collected in order; `[]` when absent. */
  multi?: Multi;
}

type ParsedKinds<
  Bools extends readonly string[],
  Multi extends readonly string[],
> = Record<Bools[number], boolean> & Record<Multi[number], string[]>;

/**
 * Parses `argv` for the flags declared in `flagSpecs`, supporting both
 * `--flag value` and `--flag=value` syntax. Flags not declared in
 * `flagSpecs` are ignored without error. A declared flag absent from `argv`
 * (or a `--flag value` form flag with no following value) resolves to
 * `undefined`.
 *
 * `kinds.booleans` and `kinds.multi` declare additional flag kinds, returned
 * alongside the string flags (see `FlagKinds`).
 */
export function parseFlags<
  const Flags extends readonly string[],
  const Bools extends readonly string[] = readonly [],
  const Multi extends readonly string[] = readonly [],
>(
  argv: readonly string[],
  flagSpecs: Flags,
  kinds: FlagKinds<Bools, Multi> = {},
): ParsedFlags<Flags> & ParsedKinds<Bools, Multi> {
  const strings = new Set<string>(flagSpecs);
  const booleans = new Set<string>(kinds.booleans ?? []);
  const multi = new Set<string>(kinds.multi ?? []);
  const result: Record<string, string | boolean | string[] | undefined> = {};
  for (const flag of strings) result[flag] = undefined;
  for (const flag of booleans) result[flag] = false;
  for (const flag of multi) result[flag] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inline = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);

    if (booleans.has(flag)) {
      result[flag] = inline === undefined ? true : inline !== "false";
    } else if (strings.has(flag) || multi.has(flag)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined) continue;
      if (inline === undefined) i++;
      if (multi.has(flag)) (result[flag] as string[]).push(value);
      else result[flag] = value;
    }
  }

  return result as ParsedFlags<Flags> & ParsedKinds<Bools, Multi>;
}

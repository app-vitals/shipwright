/**
 * lib/pg-sslmode.ts
 *
 * Pins node-postgres's TLS behavior for a Postgres connection string.
 *
 * `pg` 8.x (via pg-connection-string 2.x) treats `sslmode=prefer`, `require`,
 * and `verify-ca` as aliases for `verify-full` — the server certificate chain
 * and hostname are both verified — and logs a SECURITY WARNING saying the next
 * major (pg 9 / pg-connection-string 3) will switch them to libpq semantics,
 * where `require` means "encrypt, verify nothing". Upgrading `pg` would then
 * silently drop certificate verification for every deployment whose URL says
 * `sslmode=require`.
 *
 * Rewriting those modes to `verify-full` in the string handed to `pg` keeps
 * today's (verifying) behavior across that upgrade and silences the warning.
 * It is applied only to the `pg.Pool` connection string — never to the env var
 * itself — because the same URL is also read by the Prisma CLI
 * (`prisma migrate deploy` via prisma.config.ts), whose engine recognises only
 * `disable|prefer|require` and would read `verify-full` as `prefer`.
 *
 * Left untouched:
 *   - URLs with no `sslmode`, or `disable` / `verify-full` / `no-verify`
 *     (none of them warn, and none change meaning in pg 9);
 *   - URLs that set `uselibpqcompat=true`: that is an explicit opt-in to libpq
 *     semantics, which this must not override;
 *   - strings that are not parseable as a URL (pg accepts other forms; pass
 *     them through for pg to handle or reject).
 */

/** The sslmode values pg 8 aliases to `verify-full` (and warns about). */
const LEGACY_VERIFY_FULL_ALIASES = new Set(["prefer", "require", "verify-ca"]);

/**
 * Returns `connectionString` with a legacy `sslmode` alias replaced by
 * `verify-full`, or the input unchanged when no rewrite applies.
 */
export function pinPgSslMode(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  // Resolve the effective `sslmode` the same way pg-connection-string's
  // parse() does: iterate every query param in document order and let later
  // entries overwrite earlier ones (`config[entry[0]] = entry[1]`). A
  // duplicate `sslmode` therefore resolves to its LAST occurrence — not the
  // first, which is what `URLSearchParams#get()` would return — so this must
  // not use `.get()` here.
  let sslmode: string | null = null;
  for (const [key, value] of url.searchParams) {
    if (key === "sslmode") {
      sslmode = value;
    }
  }
  if (sslmode === null || !LEGACY_VERIFY_FULL_ALIASES.has(sslmode)) {
    return connectionString;
  }
  if (url.searchParams.get("uselibpqcompat") === "true") {
    return connectionString;
  }

  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

import { existsSync, readFileSync } from "node:fs";

const DEFAULT_ENV_PATH = `${process.env.HOME}/.vitals/.env`;

/**
 * Load a .env file into process.env if key vars are missing.
 * Safe to call unconditionally — skips if vars already set (e.g. via cron pre-load).
 * Override default path with VITALS_ENV_FILE env var.
 */
export function loadEnv(
  path = process.env.VITALS_ENV_FILE ?? DEFAULT_ENV_PATH,
): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (key && !process.env[key]) process.env[key] = val;
  }
}

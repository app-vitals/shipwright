import { existsSync, readFileSync } from "node:fs";

const DEFAULT_ENV_PATH = `${process.env.HOME}/.shipwright/.env`;

/**
 * Load a .env file into process.env if key vars are missing.
 * Safe to call unconditionally — skips if vars already set (e.g. via cron pre-load).
 * Override default path with SHIPWRIGHT_ENV_FILE env var.
 */
export function loadEnv(
  path = process.env.SHIPWRIGHT_ENV_FILE ?? DEFAULT_ENV_PATH,
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

/**
 * Fail-fast guard for required environment variables.
 * Throws with a clear error listing ALL missing vars so the operator knows exactly
 * what to set before the service can start.
 *
 * @param required - list of env var names that must be non-empty strings
 * @throws Error if any required vars are missing or empty
 */
export function validateRequiredEnv(required: string[]): void {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length === 0) return;
  throw new Error(
    `Missing required environment variables: ${missing.join(", ")}\nSet them in your .env file or environment before starting the service.`,
  );
}

/**
 * Check if public mode is enabled for metrics.
 * Reads SHIPWRIGHT_METRICS_PUBLIC_MODE — true if the value is "true" or "1", false otherwise.
 */
export function getPublicMode(): boolean {
  const val = process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE;
  return val === "true" || val === "1";
}

/**
 * Get the public repository for metrics.
 * Reads SHIPWRIGHT_METRICS_PUBLIC_REPO — returns the string or undefined.
 */
export function getPublicRepo(): string | undefined {
  return process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO || undefined;
}

/**
 * Validate that PUBLIC_REPO is set when PUBLIC_MODE=true.
 * Throws if PUBLIC_MODE=true but PUBLIC_REPO is missing.
 */
export function validatePublicModeEnv(): void {
  if (!getPublicMode()) return;
  if (!getPublicRepo()) {
    throw new Error(
      "Missing required environment variables: SHIPWRIGHT_METRICS_PUBLIC_REPO\nSet them in your .env file or environment before starting the service.",
    );
  }
}

import * as Sentry from "@sentry/bun";
import { consoleLoggingIntegration } from "@sentry/bun";
import type { BunOptions, ErrorEvent, EventHint } from "@sentry/bun";

/**
 * `@sentry/bun` doesn't re-export the `Log` type directly (it lives in `@sentry/core`, a
 * transitive dependency), so it's derived here from `beforeSendLog`'s parameter type instead of
 * adding a direct dependency on `@sentry/core`.
 */
type SentryLog = NonNullable<BunOptions["beforeSendLog"]> extends (
  log: infer L,
) => unknown
  ? L
  : never;

/** Options accepted by {@link initSentry}. */
export interface InitSentryOptions {
  /** Value tagged onto every event/log as `service` (e.g. "metrics", "agent"). */
  service: string;
}

/** The subset of the @sentry/bun client surface initSentry depends on — injectable for tests. */
export interface SentryClient {
  init: (options: Record<string, unknown>) => void;
}

/**
 * Fixed list of secret-shaped env vars redacted from Sentry events/logs. Any string value
 * (anywhere, nested) that exactly matches the *current* value of one of these is replaced
 * with "[Filtered]". Unset/empty vars are never matched, so there is no false-positive
 * redaction when a secret simply isn't configured in the current environment.
 */
const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_APP_PRIVATE_KEY",
  "GH_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_ADMIN_TOKEN",
  "SHIPWRIGHT_AGENT_API_KEY",
  "SHIPWRIGHT_TASK_STORE_TOKEN",
  "SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN",
  "SHIPWRIGHT_CHAT_SERVICE_TOKEN",
  "SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN",
  "SHIPWRIGHT_ADMIN_API_KEYS",
  "SHIPWRIGHT_SESSION_SECRET",
  "SHIPWRIGHT_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_SECRET",
] as const;

/** Max depth walked when scrubbing, so a pathological/deeply-nested object can't hang scrubbing. */
const MAX_SCRUB_DEPTH = 20;

/** Returns the currently-set (non-empty) secret env var values, recomputed per call so tests can mutate env freely. */
function liveSecretValues(): string[] {
  return SECRET_ENV_VARS.map((key) => process.env[key]).filter(
    (value): value is string => !!value,
  );
}

/** Recursively replaces string values matching a live secret with "[Filtered]", guarding against cycles and excessive depth. */
function redactSecrets<T>(
  value: T,
  secrets: string[],
  seen: WeakSet<object>,
  depth: number,
): T {
  if (secrets.length === 0) return value;

  if (typeof value === "string") {
    return (secrets.includes(value) ? "[Filtered]" : value) as unknown as T;
  }

  if (value === null || typeof value !== "object" || depth >= MAX_SCRUB_DEPTH) {
    return value;
  }

  if (seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) =>
      redactSecrets(item, secrets, seen, depth + 1),
    ) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactSecrets(val, secrets, seen, depth + 1);
  }
  return result as unknown as T;
}

/** Strips Authorization/Cookie request headers unconditionally, mutating a shallow-cloned headers object. */
function stripSensitiveHeaders(event: ErrorEvent): ErrorEvent {
  const headers = event.request?.headers;
  if (!headers) return event;

  const scrubbedHeaders = { ...headers };
  for (const key of Object.keys(scrubbedHeaders)) {
    if (
      key.toLowerCase() === "authorization" ||
      key.toLowerCase() === "cookie"
    ) {
      scrubbedHeaders[key] = "[Filtered]";
    }
  }

  return {
    ...event,
    request: { ...event.request, headers: scrubbedHeaders },
  };
}

/**
 * Sentry `beforeSend` hook: strips Authorization/Cookie request headers unconditionally, then
 * recursively redacts any string value matching a currently-set secret env var.
 */
export function scrubEvent(
  event: ErrorEvent,
  _hint: EventHint,
): ErrorEvent | null {
  const withHeadersStripped = stripSensitiveHeaders(event);
  return redactSecrets(
    withHeadersStripped,
    liveSecretValues(),
    new WeakSet(),
    0,
  );
}

/**
 * Sentry `beforeSendLog` hook: recursively redacts any string value (message, attributes, etc.)
 * matching a currently-set secret env var.
 */
export function scrubLog(log: SentryLog): SentryLog {
  return redactSecrets(log, liveSecretValues(), new WeakSet(), 0);
}

/**
 * Initializes Sentry for a Shipwright service. Reads `SENTRY_DSN` from the environment — if
 * unset, returns immediately without calling `sentryClient.init()` (zero telemetry, full stop).
 *
 * `sentryClient` defaults to the real `@sentry/bun` client but is injectable so tests can assert
 * init call/no-call behavior without `mock.module()` or `global.*` overrides.
 */
export function initSentry(
  opts: InitSentryOptions,
  sentryClient: SentryClient = Sentry,
): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  sentryClient.init({
    dsn,
    enableLogs: true,
    integrations: [
      consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
    ],
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    initialScope: { tags: { service: opts.service } },
    beforeSend: scrubEvent,
    beforeSendLog: scrubLog,
  });
}

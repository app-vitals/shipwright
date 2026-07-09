import * as Sentry from "@sentry/bun";
import { consoleLoggingIntegration } from "@sentry/bun";
import type { BunOptions, ErrorEvent, EventHint } from "@sentry/bun";
import { SECRET_ENV_VARS } from "./secret-env-vars.ts";

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

export interface InitSentryOptions {
  service: string;
}

/** Narrowed to the one method initSentry calls, so tests can inject a fake without mock.module(). */
export interface SentryClient {
  init: (options: Record<string, unknown>) => void;
}

/**
 * Narrowed to the one method callers need to report unhandled errors, so tests
 * can inject a fake without mock.module(). Mirrors the SentryClient pattern —
 * the real `Sentry` from `@sentry/bun` satisfies this shape via its
 * `captureException` export.
 */
export interface ErrorCapturingClient {
  captureException: (err: unknown) => void;
}

/** Max depth walked when scrubbing, so a pathological/deeply-nested object can't hang scrubbing. */
const MAX_SCRUB_DEPTH = 20;

/** Recomputed per call (not cached at module load) so tests can mutate env freely between assertions. */
function liveSecretValues(): string[] {
  return SECRET_ENV_VARS.map((key) => process.env[key]).filter(
    (value): value is string => !!value,
  );
}

function redactSecrets<T>(
  value: T,
  secrets: string[],
  seen: WeakSet<object>,
  depth: number,
): T {
  if (secrets.length === 0) return value;

  if (typeof value === "string") {
    let result: string = value;
    for (const secret of secrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join("[Filtered]");
      }
    }
    return result as unknown as T;
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

export function scrubLog(log: SentryLog): SentryLog {
  return redactSecrets(log, liveSecretValues(), new WeakSet(), 0);
}

/**
 * Builds the init options `initSentry` passes to `sentryClient.init` — shared
 * with callers (like `@sentry/hono`'s `sentry()` middleware) that must
 * perform their own `Sentry.init` call, so every init site gets the same
 * enableLogs/environment/scrub-hook config instead of each duplicating it.
 * Returns `undefined` when SENTRY_DSN is unset (nothing to init), or when
 * NODE_ENV is "test" — Bun auto-sets this for `bun test`, and without this
 * guard any SENTRY_DSN present in the environment would leak intentional
 * error-path test assertions to production Sentry as real events.
 */
export function buildSentryInitOptions(
  opts: InitSentryOptions,
): Record<string, unknown> | undefined {
  if (process.env.NODE_ENV === "test") return undefined;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return undefined;

  return {
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
  };
}

/** No-ops (zero telemetry, no init call) when SENTRY_DSN is unset. */
export function initSentry(
  opts: InitSentryOptions,
  sentryClient: SentryClient = Sentry,
): void {
  const options = buildSentryInitOptions(opts);
  if (!options) return;

  sentryClient.init(options);
}

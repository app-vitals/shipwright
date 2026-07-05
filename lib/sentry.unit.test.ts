import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initSentry, scrubEvent, scrubLog } from "./sentry.ts";

/** Minimal fake matching the subset of the real @sentry/bun client surface initSentry calls. */
function createFakeSentryClient() {
  const calls: unknown[] = [];
  return {
    init: (options: unknown) => {
      calls.push(options);
    },
    calls,
  };
}

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
];

// Snapshot the env vars this suite touches so we can restore them exactly,
// keeping this suite isolated from sibling suites sharing the Bun test process.
const ENV_KEYS_UNDER_TEST = [
  ...SECRET_ENV_VARS,
  "SENTRY_DSN",
  "SENTRY_ENVIRONMENT",
  "NODE_ENV",
];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    originalEnv[key] = process.env[key];
    process.env[key] = undefined;
  }
});

afterEach(() => {
  for (const key of ENV_KEYS_UNDER_TEST) {
    process.env[key] = originalEnv[key];
  }
});

describe("initSentry — SENTRY_DSN unset", () => {
  test("never calls sentryClient.init", () => {
    process.env.SENTRY_DSN = undefined;
    const fakeClient = createFakeSentryClient();

    initSentry({ service: "metrics" }, fakeClient);

    expect(fakeClient.calls.length).toBe(0);
  });
});

describe("initSentry — SENTRY_DSN set", () => {
  test("calls sentryClient.init with enableLogs, service tag, and scrub hooks wired", () => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
    const fakeClient = createFakeSentryClient();

    initSentry({ service: "metrics" }, fakeClient);

    expect(fakeClient.calls.length).toBe(1);
    const options = fakeClient.calls[0] as {
      dsn: string;
      enableLogs: boolean;
      initialScope: { tags: { service: string } };
      beforeSend: unknown;
      beforeSendLog: unknown;
      environment: string;
    };

    expect(options.dsn).toBe("https://example@o0.ingest.sentry.io/0");
    expect(options.enableLogs).toBe(true);
    expect(options.initialScope.tags.service).toBe("metrics");
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.beforeSendLog).toBe(scrubLog);
  });

  test("environment falls back to SENTRY_ENVIRONMENT, then NODE_ENV, then production", () => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";

    process.env.SENTRY_ENVIRONMENT = "staging";
    process.env.NODE_ENV = "production";
    let fakeClient = createFakeSentryClient();
    initSentry({ service: "agent" }, fakeClient);
    expect((fakeClient.calls[0] as { environment: string }).environment).toBe(
      "staging",
    );

    process.env.SENTRY_ENVIRONMENT = undefined;
    process.env.NODE_ENV = "development";
    fakeClient = createFakeSentryClient();
    initSentry({ service: "agent" }, fakeClient);
    expect((fakeClient.calls[0] as { environment: string }).environment).toBe(
      "development",
    );

    process.env.SENTRY_ENVIRONMENT = undefined;
    process.env.NODE_ENV = undefined;
    fakeClient = createFakeSentryClient();
    initSentry({ service: "agent" }, fakeClient);
    expect((fakeClient.calls[0] as { environment: string }).environment).toBe(
      "production",
    );
  });

  test("integrations include a console logging integration configured for log/warn/error", () => {
    process.env.SENTRY_DSN = "https://example@o0.ingest.sentry.io/0";
    const fakeClient = createFakeSentryClient();

    initSentry({ service: "task-store" }, fakeClient);

    const options = fakeClient.calls[0] as { integrations: unknown[] };
    expect(Array.isArray(options.integrations)).toBe(true);
    expect(options.integrations.length).toBeGreaterThan(0);
  });
});

describe("scrubEvent — header stripping", () => {
  test("strips Authorization and Cookie request headers unconditionally, even with no secrets set", () => {
    const event = {
      request: {
        headers: {
          Authorization: "Bearer abc123",
          Cookie: "session=xyz",
          "User-Agent": "test-agent",
        },
      },
    };

    const scrubbed = scrubEvent(event as never, {} as never);

    expect(scrubbed?.request?.headers?.Authorization).toBe("[Filtered]");
    expect(scrubbed?.request?.headers?.Cookie).toBe("[Filtered]");
    expect(scrubbed?.request?.headers?.["User-Agent"]).toBe("test-agent");
  });
});

describe("scrubEvent — secret redaction", () => {
  test("redacts a nested error message matching a currently-set secret env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-super-secret-value";
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "sk-ant-super-secret-value",
          },
        ],
      },
    };

    const scrubbed = scrubEvent(event as never, {} as never) as {
      exception: { values: Array<{ value: string }> };
    };

    expect(scrubbed.exception.values[0].value).toBe("[Filtered]");
  });

  test("does not redact anything when no secrets are set (no false positives)", () => {
    const event = {
      message: "a perfectly normal message",
      extra: { note: "nothing sensitive here", count: 42 },
    };

    const scrubbed = scrubEvent(
      JSON.parse(JSON.stringify(event)) as never,
      {} as never,
    );

    expect(scrubbed).toEqual(event as never);
  });

  test("does not touch non-string values", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-super-secret-value";
    const event = {
      extra: { count: 42, enabled: true, nothing: null },
    };

    const scrubbed = scrubEvent(event as never, {} as never) as unknown as {
      extra: { count: number; enabled: boolean; nothing: null };
    };

    expect(scrubbed.extra.count).toBe(42);
    expect(scrubbed.extra.enabled).toBe(true);
    expect(scrubbed.extra.nothing).toBeNull();
  });
});

describe("scrubLog — secret redaction", () => {
  test("redacts log attributes matching a currently-set secret env var", () => {
    process.env.SHIPWRIGHT_SESSION_SECRET = "super-session-secret-value";
    const log = {
      level: "error" as const,
      message: "session created",
      attributes: {
        sessionSecret: "super-session-secret-value",
        userId: "user-123",
      },
    };

    const scrubbed = scrubLog(structuredClone(log));

    expect(scrubbed.attributes?.sessionSecret).toBe("[Filtered]");
    expect(scrubbed.attributes?.userId).toBe("user-123");
  });

  test("does not redact anything when no secrets are set (no false positives)", () => {
    const log = {
      level: "info" as const,
      message: "normal log line",
      attributes: { foo: "bar", count: 1 },
    };

    const scrubbed = scrubLog(structuredClone(log));

    expect(scrubbed).toEqual(log);
  });

  test("handles circular references without infinite looping", () => {
    process.env.GH_TOKEN = "ghp_secretvalue";
    const attributes: Record<string, unknown> = { token: "ghp_secretvalue" };
    attributes.self = attributes;
    const log = {
      level: "warn" as const,
      message: "circular test",
      attributes,
    };

    // Should complete without throwing / hanging.
    const scrubbed = scrubLog(log);

    expect(scrubbed.attributes?.token).toBe("[Filtered]");
  });
});

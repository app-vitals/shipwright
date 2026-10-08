import { describe, expect, mock, test } from "bun:test";
import {
  createAccountCreatedNotifier,
  fireAccountCreatedNotification,
} from "./account-created-notifier.ts";

const info = { accountId: "acc_1", emailDomain: "example.com" };

describe("createAccountCreatedNotifier", () => {
  test("not configured: no push service or no admins → undefined", () => {
    expect(createAccountCreatedNotifier({ adminEmails: ["a@x.com"] })).toBe(
      undefined,
    );
    const pushService = { sendToUsers: mock(async () => ({})) };
    expect(createAccountCreatedNotifier({ pushService, adminEmails: [] })).toBe(
      undefined,
    );
  });

  test("success: pushes one generic payload to the operators", async () => {
    const sendToUsers = mock(async () => ({}));
    const notifier = createAccountCreatedNotifier({
      pushService: { sendToUsers },
      adminEmails: ["a@x.com"],
    });
    await notifier?.(info);
    expect(sendToUsers).toHaveBeenCalledTimes(1);
    const [emails, build] = sendToUsers.mock.calls[0] as unknown as [
      string[],
      (l: string) => string,
    ];
    expect(emails).toEqual(["a@x.com"]);
    const payload = JSON.parse(build("preview"));
    expect(payload.title).toBe("New account created");
    expect(payload.body).toBe("");
    expect(payload.url).toBe("/admin/agents");
    expect(JSON.stringify(payload)).not.toContain("example.com");
  });
});

describe("fireAccountCreatedNotification", () => {
  test("async rejection is caught and logged, never thrown", async () => {
    const logError = mock(() => {});
    const notifier = mock(async () => {
      throw new Error("push down");
    });
    expect(() =>
      fireAccountCreatedNotification(notifier, info, logError),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test("synchronous throw is caught and logged", () => {
    const logError = mock(() => {});
    const notifier = (() => {
      throw new Error("boom");
    }) as never;
    expect(() =>
      fireAccountCreatedNotification(notifier, info, logError),
    ).not.toThrow();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  test("not configured: no-op", () => {
    expect(() => fireAccountCreatedNotification(undefined, info)).not.toThrow();
  });
});

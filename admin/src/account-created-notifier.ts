/**
 * admin/src/account-created-notifier.ts
 * Best-effort operator notification when self-serve sign-in auto-creates an
 * account (SSP-3.3). Reuses the existing web-push wiring — no new integration.
 * When push isn't configured, the structured `account_created` log emitted by
 * the Google callback (SSP-3.1) is the only signal.
 *
 * Never throws and is never awaited by the login path: a notifier failure
 * must not fail or slow sign-in.
 */

import type { PushDetailLevel } from "./push-content.ts";

export interface AccountCreatedInfo {
  accountId: string;
  emailDomain: string;
}

export type AccountCreatedNotifier = (
  info: AccountCreatedInfo,
) => Promise<void>;

export interface AccountCreatedPushLike {
  sendToUsers(
    emails: string[],
    buildPayload: (level: PushDetailLevel) => string,
  ): Promise<unknown>;
}

const TITLE = "New account created";

/** Returns undefined when push or the operator allowlist isn't configured. */
export function createAccountCreatedNotifier(deps: {
  pushService?: AccountCreatedPushLike;
  adminEmails: string[];
}): AccountCreatedNotifier | undefined {
  const { pushService, adminEmails } = deps;
  if (!pushService || adminEmails.length === 0) return undefined;
  return async (info) => {
    // Generic payload only: the domain is user-derived, so it stays out of the
    // lock-screen-visible fields; operators read it from the structured log.
    await pushService.sendToUsers(adminEmails, () =>
      JSON.stringify({
        title: TITLE,
        body: "",
        url: "/admin/agents",
        tag: `account-created:${info.accountId}`,
      }),
    );
  };
}

/**
 * Fire-and-forget: invokes the notifier without awaiting it and swallows both
 * synchronous throws and async rejections.
 */
export function fireAccountCreatedNotification(
  notifier: AccountCreatedNotifier | undefined,
  info: AccountCreatedInfo,
  logError: (msg: string, err: unknown) => void = (msg, err) =>
    console.error(msg, err),
): void {
  if (!notifier) return;
  try {
    notifier(info).catch((err) =>
      logError("[admin] account-created notification failed", err),
    );
  } catch (err) {
    logError("[admin] account-created notification failed", err);
  }
}

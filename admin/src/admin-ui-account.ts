/**
 * admin/src/admin-ui-account.ts
 * GET/POST /admin/account — self-serve account management (SSP-3.2): name,
 * quota, members, pending invites. Owners manage; members are read-only.
 *
 * Registered into admin-ui.ts's app via registerAccountRoutes(). Flag-gated:
 * every route 404s when self-serve is off, and for signed-in users with no
 * account.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AccountInviteService } from "./account-invites.ts";
import {
  AccountMemberNotFoundError,
  type AccountMemberService,
  LastOwnerError,
} from "./account-members.ts";
import { normalizeEmail } from "./account-email.ts";
import type { Account, AccountService } from "./accounts.ts";
import { ACCOUNT_PATH, renderAccountPage } from "./admin-ui-account-pages.ts";
import type { AdminUIEnv } from "./admin-ui.ts";

export interface AccountRouteDeps {
  /** SHIPWRIGHT_SELF_SERVE_ENABLED === "enabled". */
  enabled: boolean;
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  accounts: Pick<AccountService, "getByMemberEmail" | "update" | "countAgents">;
  members: Pick<
    AccountMemberService,
    "listByAccount" | "getByEmail" | "remove" | "promote" | "demote"
  >;
  invites: Pick<AccountInviteService, "create" | "listPending" | "revoke">;
  html: (content: string, opts?: { status?: number }) => Response;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 100;

export function registerAccountRoutes(
  app: Hono<AdminUIEnv>,
  deps: AccountRouteDeps,
): void {
  const notFound = () => new Response("Not Found", { status: 404 });

  // Flag-off 404s before auth so the route is indistinguishable from absent.
  app.use(`${ACCOUNT_PATH}`, async (_c, next) =>
    deps.enabled ? next() : notFound(),
  );
  app.use(`${ACCOUNT_PATH}/*`, async (_c, next) =>
    deps.enabled ? next() : notFound(),
  );

  async function render(
    c: Context<AdminUIEnv>,
    account: Account,
    isOwner: boolean,
    error?: string,
    status = 200,
  ): Promise<Response> {
    const [members, invites, agentCount] = await Promise.all([
      deps.members.listByAccount(account.id),
      deps.invites.listPending(account.id),
      deps.accounts.countAgents(account.id),
    ]);
    return deps.html(
      renderAccountPage({
        userEmail: c.var.userEmail,
        account,
        agentCount,
        members,
        invites,
        isOwner,
        error,
      }),
      { status },
    );
  }

  /** Resolves the caller's account + role, or a 404 Response. */
  async function resolve(
    c: Context<AdminUIEnv>,
  ): Promise<{ account: Account; isOwner: boolean } | Response> {
    const account = await deps.accounts.getByMemberEmail(c.var.userEmail);
    if (!account) return notFound();
    const me = await deps.members.getByEmail(c.var.userEmail);
    return { account, isOwner: me?.role === "owner" };
  }

  app.get(ACCOUNT_PATH, deps.requireAuth, async (c) => {
    const ctx = await resolve(c);
    if (ctx instanceof Response) return ctx;
    return render(c, ctx.account, ctx.isOwner);
  });

  /**
   * Shared shape for owner-only POST actions: resolve + 403 for non-owners,
   * read one form field, run the action, 302 back on success, or re-render
   * with the error and a 4xx on a known failure.
   */
  function ownerAction(
    path: string,
    field: "email" | "name",
    run: (args: {
      account: Account;
      value: string;
      userEmail: string;
    }) => Promise<string | undefined>,
  ): void {
    app.post(`${ACCOUNT_PATH}/${path}`, deps.requireAuth, async (c) => {
      const ctx = await resolve(c);
      if (ctx instanceof Response) return ctx;
      if (!ctx.isOwner) return new Response("Forbidden", { status: 403 });

      let value = "";
      try {
        const form = await c.req.formData();
        value = (form.get(field)?.toString() ?? "").trim();
      } catch {
        // malformed body — treated as an empty value below
      }

      try {
        const error = await run({
          account: ctx.account,
          value,
          userEmail: c.var.userEmail,
        });
        if (error) return render(c, ctx.account, true, error, 400);
      } catch (err) {
        if (err instanceof LastOwnerError) {
          return render(
            c,
            ctx.account,
            true,
            "Cannot remove or demote the last owner of the account.",
            400,
          );
        }
        if (err instanceof AccountMemberNotFoundError) {
          return render(c, ctx.account, true, "Member not found.", 404);
        }
        throw err;
      }
      return c.redirect(ACCOUNT_PATH, 302);
    });
  }

  ownerAction("invite", "email", async ({ account, value, userEmail }) => {
    if (!EMAIL_RE.test(value)) return "Enter a valid email address.";
    if (await deps.members.getByEmail(value)) {
      return "That email already belongs to an account.";
    }
    await deps.invites.create(account.id, value, normalizeEmail(userEmail));
    return undefined;
  });

  ownerAction("invites/revoke", "email", async ({ account, value }) => {
    await deps.invites.revoke(account.id, value);
    return undefined;
  });

  ownerAction("members/remove", "email", async ({ account, value }) => {
    await deps.members.remove(account.id, value);
    return undefined;
  });

  ownerAction("members/promote", "email", async ({ account, value }) => {
    await deps.members.promote(account.id, value);
    return undefined;
  });

  ownerAction("members/demote", "email", async ({ account, value }) => {
    await deps.members.demote(account.id, value);
    return undefined;
  });

  ownerAction("rename", "name", async ({ account, value }) => {
    if (!value) return "Account name is required.";
    if (value.length > MAX_NAME_LENGTH) {
      return `Account name must be at most ${MAX_NAME_LENGTH} characters.`;
    }
    await deps.accounts.update(account.id, { name: value });
    return undefined;
  });
}

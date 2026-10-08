/**
 * admin/src/admin-ui-accounts.ts
 * GET/POST /admin/accounts[/:id] — platform-admin account management
 * (SSP-5.2). Admin only (403 otherwise) and flag-gated (404 when self-serve
 * is off). Suspend/reactivate only set Account.status; lockdown side effects
 * are SSP-8.2.
 */

import type { Context, Hono, MiddlewareHandler } from "hono";
import { normalizeEmail } from "./account-email.ts";
import type { AccountInviteService } from "./account-invites.ts";
import {
  AccountMemberNotFoundError,
  type AccountMemberService,
  LastOwnerError,
} from "./account-members.ts";
import type { AccountService } from "./accounts.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import {
  type AccountAgentRef,
  ADMIN_ACCOUNTS_PATH,
  renderAccountDetailPage,
  renderAccountsListPage,
} from "./admin-ui-accounts-pages.ts";
import { reconcileAgentAfterAccountChange } from "./agent-account-assignment.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentService } from "./agents.ts";

export interface AdminAccountsRouteDeps {
  /** SHIPWRIGHT_SELF_SERVE_ENABLED === "enabled". */
  enabled: boolean;
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  accounts: Pick<
    AccountService,
    "listWithCounts" | "getWithCounts" | "update" | "listAgents"
  >;
  members: Pick<
    AccountMemberService,
    "listByAccount" | "getByEmail" | "add" | "remove" | "promote" | "demote"
  >;
  invites: Pick<AccountInviteService, "listPending">;
  /** SSP-5.3: assign/unassign agents (admin only). */
  agents: Pick<AgentService, "getDetail" | "updateFields">;
  provisioner: Pick<AgentProvisioner, "reconcile">;
  html: (content: string, opts?: { status?: number }) => Response;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 100;

export function registerAdminAccountsRoutes(
  app: Hono<AdminUIEnv>,
  deps: AdminAccountsRouteDeps,
): void {
  const notFound = () => new Response("Not Found", { status: 404 });
  const forbidden = () => new Response("Forbidden", { status: 403 });

  app.use(ADMIN_ACCOUNTS_PATH, async (_c, next) =>
    deps.enabled ? next() : notFound(),
  );
  app.use(`${ADMIN_ACCOUNTS_PATH}/*`, async (_c, next) =>
    deps.enabled ? next() : notFound(),
  );

  const requireAdmin: MiddlewareHandler<AdminUIEnv> = async (c, next) =>
    c.var.isAdmin === true ? next() : forbidden();

  app.get(ADMIN_ACCOUNTS_PATH, deps.requireAuth, requireAdmin, async (c) => {
    const accounts = await deps.accounts.listWithCounts();
    const owners = new Map<string, string[]>();
    await Promise.all(
      accounts.map(async (a) => {
        const members = await deps.members.listByAccount(a.id);
        owners.set(
          a.id,
          members.filter((m) => m.role === "owner").map((m) => m.email),
        );
      }),
    );
    return deps.html(
      renderAccountsListPage({ userEmail: c.var.userEmail, accounts, owners }),
    );
  });

  async function renderDetail(
    c: Context<AdminUIEnv>,
    id: string,
    error?: string,
    status = 200,
  ): Promise<Response> {
    const account = await deps.accounts.getWithCounts(id);
    if (!account) return notFound();
    const [agents, members, invites] = await Promise.all([
      deps.accounts.listAgents(id),
      deps.members.listByAccount(id),
      deps.invites.listPending(id),
    ]);
    return deps.html(
      renderAccountDetailPage({
        userEmail: c.var.userEmail,
        account,
        agents: agents as AccountAgentRef[],
        members,
        invites,
        error,
      }),
      { status },
    );
  }

  app.get(`${ADMIN_ACCOUNTS_PATH}/:id`, deps.requireAuth, requireAdmin, (c) =>
    renderDetail(c, c.req.param("id")),
  );

  /**
   * Admin POST action: 404 for unknown account, runs `run` with the form,
   * 302 back to the detail page on success, re-renders with the error on a
   * known failure.
   */
  function action(
    path: string,
    run: (args: { id: string; form: FormData }) => Promise<string | undefined>,
  ): void {
    app.post(
      `${ADMIN_ACCOUNTS_PATH}/:id/${path}`,
      deps.requireAuth,
      requireAdmin,
      async (c) => {
        const id = c.req.param("id");
        if (!(await deps.accounts.getWithCounts(id))) return notFound();
        let form = new FormData();
        try {
          form = await c.req.formData();
        } catch {
          // malformed body — treated as empty fields below
        }
        try {
          const error = await run({ id, form });
          if (error) return renderDetail(c, id, error, 400);
        } catch (err) {
          if (err instanceof LastOwnerError) {
            return renderDetail(
              c,
              id,
              "Cannot remove or demote the last owner of the account.",
              400,
            );
          }
          if (err instanceof AccountMemberNotFoundError) {
            return renderDetail(c, id, "Member not found.", 404);
          }
          throw err;
        }
        return c.redirect(`${ADMIN_ACCOUNTS_PATH}/${id}`, 302);
      },
    );
  }

  const field = (form: FormData, name: string) =>
    (form.get(name)?.toString() ?? "").trim();

  action("update", async ({ id, form }) => {
    const name = field(form, "name");
    if (!name) return "Account name is required.";
    if (name.length > MAX_NAME_LENGTH) {
      return `Account name must be at most ${MAX_NAME_LENGTH} characters.`;
    }
    const maxRaw = field(form, "maxAgents");
    const maxAgents = Number(maxRaw);
    if (maxRaw === "" || !Number.isInteger(maxAgents) || maxAgents < 0) {
      return "Max agents must be a non-negative integer.";
    }
    const trialRaw = field(form, "trialExpiresAt");
    let trialExpiresAt: Date | null = null;
    if (trialRaw) {
      trialExpiresAt = new Date(trialRaw);
      if (Number.isNaN(trialExpiresAt.getTime())) {
        return "Trial expiry must be a valid date.";
      }
    }
    await deps.accounts.update(id, {
      name,
      maxAgents,
      plan: field(form, "plan") || null,
      trialExpiresAt,
    });
    return undefined;
  });

  action("suspend", async ({ id }) => {
    await deps.accounts.update(id, { status: "suspended" });
    return undefined;
  });

  action("reactivate", async ({ id }) => {
    await deps.accounts.update(id, { status: "active" });
    return undefined;
  });

  /** SSP-5.3: set (accountId) or clear (null) Agent.accountId, then reconcile. */
  async function setAgentAccount(
    agentId: string,
    accountId: string | null,
  ): Promise<undefined> {
    const updated = await deps.agents.updateFields(agentId, { accountId });
    // The change is committed; a reconcile failure is logged, not surfaced as
    // a form error (the next reconcile pass converges the workload).
    const warning = await reconcileAgentAfterAccountChange(
      deps.provisioner,
      updated,
    );
    if (warning) console.warn(`[admin-accounts] ${agentId}: ${warning}`);
    return undefined;
  }

  action("agents/assign", async ({ id, form }) => {
    const agentId = field(form, "agentId");
    if (!agentId) return "Agent ID is required.";
    if (!(await deps.agents.getDetail(agentId))) {
      return `Agent ${agentId} not found.`;
    }
    return setAgentAccount(agentId, id);
  });

  action("agents/unassign", async ({ id, form }) => {
    const agentId = field(form, "agentId");
    const agent = await deps.agents.getDetail(agentId);
    if (!agent || agent.accountId !== id) {
      return "Agent is not assigned to this account.";
    }
    return setAgentAccount(agentId, null);
  });

  action("members/add", async ({ id, form }) => {
    const email = normalizeEmail(field(form, "email"));
    if (!EMAIL_RE.test(email)) return "Enter a valid email address.";
    if (await deps.members.getByEmail(email)) {
      return "That email already belongs to an account.";
    }
    const role = field(form, "role") === "owner" ? "owner" : "member";
    await deps.members.add(id, email, role);
    return undefined;
  });

  action("members/remove", async ({ id, form }) => {
    await deps.members.remove(id, field(form, "email"));
    return undefined;
  });
  action("members/promote", async ({ id, form }) => {
    await deps.members.promote(id, field(form, "email"));
    return undefined;
  });
  action("members/demote", async ({ id, form }) => {
    await deps.members.demote(id, field(form, "email"));
    return undefined;
  });
}

# Self-Serve Agent Provisioning

Self-serve lets customers of **Shipwright Managed** sign in with Google, get their own account, and create and run their own agents up to an admin-granted quota — without an operator creating each agent. It sits behind a feature flag that defaults off.

## Who it is for

- **Shipwright Managed only.** The flag exists for the multi-tenant, operator-run deployment.
- **Not for customer-infrastructure or self-hosted deployments.** Leave it unset there; behavior is unchanged (no account route, page or sign-in path is reachable, and an unknown email still gets the existing 403 at login).

Enable it with the Helm chart's `selfServe.enabled=true`, which injects `SHIPWRIGHT_SELF_SERVE_ENABLED=enabled`. The env vars are documented in [Configuration → Self-Serve Provisioning](./configuration.md#self-serve-provisioning):

| Name | Purpose |
|---|---|
| `SHIPWRIGHT_SELF_SERVE_ENABLED` | `enabled` turns the capability on; anything else leaves it off. |
| `SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS` | Quota given to self-created accounts (default `0`). |
| `SHIPWRIGHT_SELF_SERVE_CONTACT_EMAIL` | Address shown to users who need quota (default `dan@app-vitals.com`). |

## Sign-in and invites

Self-serve sign-in is **Google only** (Okta behavior is unchanged), and only **verified** Google emails are eligible. On first login, a verified email that is not a platform admin, has no `AgentMember` rows and has no account is resolved as follows:

- **Pending invite** — the user joins the inviting account as `member`, and the invite is marked accepted.
- **No invite** — a new account is created with the user as `owner`, `status = active`, `maxAgents` from `SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS`, and the email's local part as the account name.

Both paths run in one transaction, so concurrent first logins for the same email yield one account. Platform admins and existing `AgentMember` users log in as before. An email belongs to at most one account.

Account owners can invite by email, list and revoke pending invites, remove members, and promote a member to `owner`. The last owner cannot be removed or demoted. Platform admins can also create an account up front with `POST /accounts` (owner email, quota, optional trial); the owner's first login lands in it.

## Quota and trials

Each account has a `maxAgents` quota. Self-created accounts start at the configured default, normally `0`. At zero quota the agents page shows an empty state telling the user to email the contact address to request a trial, and the create button is disabled.

- **Quota** counts the account's non-deleted agents. Creation fails with a clear error when `count >= maxAgents` or the account is not `active`, and nothing is created or provisioned. The check runs inside the creating transaction, so concurrent creates cannot exceed the quota. Deleting an agent frees quota immediately.
- **Granting quota.** A platform admin raises `maxAgents` on the account from `/admin/accounts` (or `PATCH /accounts/:id`). The admin can also edit `name` and `plan`, set `trialExpiresAt`, suspend or reactivate the account, and manage its members and invites.
- **Trials.** When `trialExpiresAt` is set, a warning goes out once, 3 days before expiry. After expiry the account's status becomes `trial_expired`.
- **Suspension.** Suspending an account, or a `trial_expired` status, locks down every agent in it: crons are disabled and Slack messages get a "paused" notice. Nothing is deleted, and new agent creation is blocked. Reactivating (`status = active`, with a cleared or extended `trialExpiresAt`) restores Slack immediately and re-enables exactly the crons the lockdown disabled.
- `Account.plan` is a billing hook only; payments are not implemented.

## Roles

| Role | Who | Can do |
|---|---|---|
| Platform admin | Env-var admin (`SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` / `SHIPWRIGHT_ADMIN_API_KEYS`) | Everything, across all accounts: the Accounts view, quota, trials, suspension, and reassigning agents between accounts. |
| Account owner | First sign-in, or promoted | Everything a member can, plus invites and member management for the account. |
| Account member | Invited by email | Full control of the account's agents. |

A non-admin session is non-admin at the JSON API too: the `admin_session` cookie's `isAdmin` claim is honoured, and cross-agent routes such as `POST /agents/reconcile` stay admin-only. `accountId` is never accepted from a request body; it comes from the authenticated session or token. Bearer-token behavior is unchanged.

## What a tenant can do

Owners and members create, configure and delete agents in their account, up to quota:

- Agents are fixed to the `coding` type.
- **Bring your own credentials:** an Anthropic API key or Claude Code OAuth token supplied at create time, a Slack app (needs the customer's own Slack App Configuration Token) and a GitHub PAT, manual GitHub App entry or the auto App manifest flow under the customer's own org. The new-agent form lists these prerequisites and the remaining quota.
- Full per-agent control: settings, repos, allowlists, envs (including `ANTHROPIC_*`, `SLACK_*`, `GH_*`), crons, tools, plugins, tokens, chat, members and delete. There is **no reserved-key lockdown** in Phase 1 — tenants can run arbitrary shell in their pods through tools and cron `preCheck`, so containment relies on the isolation below.
- The Tasks, PRs and Sessions views show only the account's own rows.

The create path is shared with `POST /agents`; see [Agent API](./agent-api.md).

## Isolation model and known limits

Phase 1 is "option A": tenants share one Kubernetes namespace (`SHIPWRIGHT_K8S_NAMESPACE`) with these controls:

- **NetworkPolicy** on tenant pods (label `shipwright.dev/tenant=true`): egress to DNS, the Shipwright services and the public internet only, with private ranges, link-local and the metadata endpoint blocked; ingress from admin only. It is flag-gated by `selfServe.networkPolicy.enabled` and only enforced if the cluster CNI supports NetworkPolicy. **Enable it before allowing any tenant agents.** See [Tenant agent NetworkPolicy](./deploy-kubernetes-networking.md#tenant-agent-networkpolicy-self-serve-opt-in).
- **CPU limit** on tenant containers, tunable through the `SHIPWRIGHT_K8S_AGENT_*` overrides (see [agent provisioning](./deploy-kubernetes-provisioning.md)).
- **Task-store tenancy:** tasks, PRs, sessions and verification checks carry an `accountId`; account-scoped tokens only read and write their own rows. Existing platform rows use the `default` account.

Known limits:

- **Shared namespace.** Tenants are separated by policy and labels, not by namespace.
- **No per-account ResourceQuota.** A Kubernetes ResourceQuota is per namespace, so it cannot be per account here. Bounds come from `maxAgents` × the fixed per-pod requests and limits, enforced in admin, plus the tenant CPU limit.
- **Task id collisions.** Task ids stay globally unique. If an account-scoped token creates a task whose id exists in another account, it gets a generic 409 ("task id unavailable"). Namespacing ids is a follow-up.

## Phase 2 (not built)

- A public shared Slack app and GitHub App (multi-workspace OAuth, per-install token storage, event routing and tenancy).
- Namespace-per-account isolation, which also enables real per-account ResourceQuotas — required before public signup beyond trusted users.
- Payments and per-agent pricing (hooks: `Account.plan`, `maxAgents`).
- Okta-based self-serve signup, multiple accounts per email, and agent types other than `coding`.

# Self-Serve Agent Provisioning — Product Specification

**Date**: 2026-10-08
**Session**: self-serve-agent-provisioning
**Status**: Draft
**Repo**: `app-vitals/shipwright`

## Overview

A multi-tenant `Account` layer for Shipwright Managed so customers can sign in with Google, get their own account, and provision and manage their own agents (up to a per-account quota) without an operator creating each agent. Phase 1 is bring-your-own Slack app, GitHub App and Claude credentials, with invite-based account joining, per-account tenancy across admin and task-store, and an admin-controlled quota that starts at zero. The whole capability sits behind a feature flag that defaults off, so self-hosted deployments are unchanged. Payments (the eventual $X/month per agent) are out of scope; `Account.plan` and `maxAgents` are the hooks.

## Problem Statement

Agent provisioning is admin-only. `GET/POST /admin/agents/new`, `POST /agents` and agent deletion all require the env-var admin (`SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` / `SHIPWRIGHT_ADMIN_API_KEYS`), and a non-admin who has no `AgentMember` row gets a 403 at login (`admin/src/admin-ui.ts:1082`). There is no concept of a customer, tenant or quota anywhere in the schema, so the only way to give someone an agent is for an operator to create it for them. That does not scale to a paid self-serve product.

Opening the existing UI to outsiders is also unsafe today: the JSON API treats every valid `admin_session` cookie as admin (`admin/src/api-auth.ts:~176-178` ignores the JWT's `isAdmin` claim), the task-store scopes tenancy only by `repo` string, and agent pods share one namespace with no NetworkPolicy, ResourceQuota or CPU limit.

## Users & Context

- **Self-serve customer (account owner)** — signs in with Google, owns an account, and creates and runs agents against their own Slack workspace, GitHub org and Claude credentials, up to their quota.
- **Account member** — invited by an owner (by email); gets full control of the account's agents.
- **Platform admin (App Vitals operator)** — the existing env-var admin. Sees and manages all accounts, grants quota and trials, suspends accounts.
- **Self-hosted / customer-infra deployments** — must see no behavior change; the feature is off for them.

---

## Features

### Feature 1: Account model, `accountId` linkage and feature flag

**Priority**: High
**Description**: The data foundation: an `Account` entity with owner, members, quota, status and plan, nullable `Agent.accountId`, and a flag that gates the entire capability.

**User Stories**:
- As a platform admin, I want accounts to be a first-class entity with a quota so that I can control how many agents each customer provisions.
- As a self-hosted operator, I want self-serve off by default so that my deployment behaves exactly as it does today.

**Requirements**:
- New `Account` model: `id`, `name`, `status` (`active` | `suspended` | `trial_expired`), `maxAgents` (int, default from config, initially 0), `plan` (nullable string, billing hook, unused in Phase 1), `trialExpiresAt` (nullable), `trialExpiryWarnedAt` (nullable), timestamps.
- New `AccountMember` model: `accountId`, `email` (lowercased), `role` (`owner` | `member`), unique on `[accountId, email]`, indexed on `email`. An account has at least one `owner`. A given email belongs to at most one account in Phase 1 (unique on `email`).
- New `AccountInvite` model: `accountId`, `email` (lowercased), `invitedBy`, `createdAt`, `acceptedAt` (nullable). Unique on `[accountId, email]` while pending.
- `Agent.accountId` nullable foreign key. Null means a platform-owned agent (every existing agent and every self-hosted agent). Additive migration only.
- Env flag `SHIPWRIGHT_SELF_SERVE_ENABLED` (`enabled` | unset), read once in `admin/src/main.ts` and injected as a dep, following the `SHIPWRIGHT_K8S_PROVISIONING` pattern. Pure helper plus unit test, like `dev-auth-guard.ts`. When off, no account route, page, or sign-in path is reachable and all behavior matches today.
- Env `SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS` (default `0`) sets `maxAgents` on self-created accounts. Helm values and `docs/configuration.md` updated; `task check-config-docs` passes.

**Acceptance Criteria**:
- [ ] Migration is additive only; all existing `Agent` rows have `accountId = null` and are unaffected
- [ ] With the flag unset, every `/admin/accounts*` and account API route returns 404 and the sign-in path is byte-for-byte today's behavior
- [ ] Unique constraint on `AccountMember.email` rejects adding the same email to two accounts
- [ ] `SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS` unset yields `maxAgents = 0` on a new account
- [ ] Helm `values.yaml`, `values.schema.json`, chart unit tests and `docs/configuration.md` cover both new env vars
- [ ] Unit test for the flag helper; integration test for model constraints against real Postgres

**Technical Considerations**: Mirror the nullable-additive pattern used for `trialExpiresAt`. Reuse the `AgentMember` service shape (`admin/src/agent-members.ts`) for `AccountMemberService`. Pass the transaction client as `createAgent()` does.

**Source Map**:
- `admin/prisma/schema.prisma` — `Account`, `AccountMember`, `AccountInvite`, `Agent.accountId`
- `admin/src/main.ts` — flag and default-quota env parsing, dep injection
- `admin/src/agent-members.ts` — pattern to follow for the new member service
- `charts/shipwright/values.yaml`, `values.schema.json`, `templates/admin-deployment.yaml` — env wiring
- `docs/configuration.md` — new env var docs

**Testing Strategy**: Layer: integration — constraints and migration run against real Postgres; flag helper is unit.

---

### Feature 2: Session and API authorization hardening

**Priority**: High (must land before the flag can be enabled anywhere)
**Description**: Make non-admin sessions actually non-admin at the JSON API layer and give every request a resolved account scope.

**Requirements**:
- `createAdminAuthMiddleware` (`admin/src/api-auth.ts`) must read `isAdmin` from the `admin_session` JWT payload instead of unconditionally setting `isAdmin = true` for any valid cookie.
- A non-admin cookie session resolves an account scope: the set of agent ids the caller may access (agents with the caller's `accountId`, plus any explicit `AgentMember` rows). Admin keeps the "all" scope.
- All `/agents/*` JSON routes enforce the scope: `GET /agents` is filtered; per-agent routes (`/agents/:id/*`) return 403 for an agent outside scope; `POST /agents` for a non-admin runs the account-owner path in Feature 4 (quota checked, `accountId` forced to the caller's account, never client-supplied); `POST /agents/reconcile` and other cross-agent routes stay admin-only.
- Extend `visibleAgentIdsFor` / `isSessionVisible` (`admin/src/session-scope.ts`) to take account membership into account.
- Bearer-token behavior (`SHIPWRIGHT_ADMIN_API_KEYS`, per-agent tokens) is unchanged.

**Acceptance Criteria**:
- [ ] A non-admin `admin_session` cookie calling `GET /agents` receives only agents in its scope
- [ ] A non-admin cookie calling `PATCH /agents/:id` or `DELETE /agents/:id` for an agent in another account receives 403
- [ ] A non-admin cookie calling `POST /agents/reconcile` receives 403
- [ ] An admin cookie session retains full access (regression test)
- [ ] `POST /agents` by a non-admin ignores any `accountId` in the body and uses the caller's account
- [ ] Bearer tokens (admin keys and per-agent tokens) behave identically to before (regression tests)
- [ ] Unit tests for the extended scope helpers cover admin, account member, explicit `AgentMember` and no-membership callers

**Technical Considerations**: Today, "member" sessions already hold the API admin bit; this is a latent security bug on `main` independent of this feature, so this feature should be shippable and mergeable on its own, first. Cookie name and secret are shared between the UI and the JSON API, so the claim in the JWT is the source of truth.

**Source Map**:
- `admin/src/api-auth.ts` — read JWT `isAdmin`, resolve account scope
- `admin/src/agents-api.ts` — per-route scope checks, `POST /agents` non-admin path
- `admin/src/session-scope.ts` — extend scope helpers
- `admin/src/admin-ui.ts` — `assertAgentAccess` (~L1560), `resolveAccessibleAgents` (~L1437)

**Testing Strategy**: Layer: smoke — HTTP route contract with injected session claims (the `x-test-is-admin` header pattern in `admin-ui-sessions-list.smoke.test.ts`), plus unit tests for pure scope helpers.

---

### Feature 3: Sign-in, invites and account creation

**Priority**: High
**Description**: Google sign-in creates or joins an account. No invite means a new account with that user as owner; an invite means joining the inviting account.

**User Stories**:
- As a new customer, I want to sign in with Google and immediately have an account so that I can start setting up.
- As an account owner, I want to invite teammates by email so that they join my account.
- As a signed-in user with zero quota, I want to be told how to request a trial.

**Requirements**:
- In `completeLogin()` (`admin-ui.ts:1060-1117`), when the flag is on, a verified email that is not a platform admin, has no `AgentMember` rows, and has no account is resolved as follows: a pending `AccountInvite` for that email joins that account as `member` and marks the invite accepted; otherwise a new `Account` is created with the user as `owner`, `status = active`, `maxAgents = SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS`, and the account name defaulting to the email's local part. Both happen in one transaction; concurrent first logins for the same email must not create two accounts.
- Users who already have `AgentMember` rows or are platform admins keep today's behavior; users with an account go to their account's scoped views.
- Only verified Google emails are eligible. Okta behavior is unchanged.
- An account owner can invite by email, list and revoke pending invites, remove members and, for owners, promote a member to `owner`. The last owner cannot be removed or demoted.
- Accounts with `maxAgents = 0` show a clear empty state on the agents page: "Email dan@app-vitals.com to request a trial." The contact address is an env/config value with this default.
- When an account is created via self-signup, send a best-effort admin notification (reusing existing admin Slack/push alerting if present) so an operator knows someone signed up; failure to notify never blocks signup.

**Acceptance Criteria**:
- [ ] First Google login for an unknown verified email with the flag on creates exactly one account, one `owner` member and a session with that account's scope
- [ ] First login for an email with a pending invite joins the inviting account as `member`, creates no new account, and marks the invite accepted
- [ ] Two concurrent first logins for the same email yield one account (verified by a test)
- [ ] With the flag off, an unknown email still gets the existing 403 at login
- [ ] An unverified Google email is rejected and creates nothing
- [ ] Removing or demoting the last owner returns an error and changes nothing
- [ ] A zero-quota account's agents page shows the request-a-trial message with the configured contact address, and the create button is disabled
- [ ] Platform admins and existing `AgentMember` users log in exactly as before (regression tests)

**Technical Considerations**: Google verified-email handling already exists in `completeLogin`. Account auto-create is a new write path on login, so keep it idempotent and transactional. Treat the email as the identity; lowercase on write and read.

**Source Map**:
- `admin/src/admin-ui.ts` — `completeLogin`, login/redirect handling, new account/invite routes
- `admin/src/admin-ui-pages.ts` — account settings, members and invites pages, empty state
- `admin/src/account-members.ts` (new), `admin/src/account-invites.ts` (new)

**Testing Strategy**: Layer: smoke for login/route contracts with injected OIDC identity, integration for the transactional create/join and concurrency cases against real Postgres.

---

### Feature 4: Account-scoped agent management

**Priority**: High
**Description**: Owners and members create, configure and delete agents in their account, with full control over each agent, up to quota.

**User Stories**:
- As an account owner, I want to create an agent against my own Slack workspace and GitHub org with my own Claude credentials so that I'm not dependent on an operator.
- As an account member, I want full control over my account's agents so that I can run them without asking an owner.

**Requirements**:
- Account owners and members may use `GET/POST /admin/agents/new`, `POST /admin/agents` and `POST /admin/agents/:id/delete` for agents in their account. `createAgent()` receives an `accountId`, sets it on the Agent in the same transaction and enforces quota atomically (no two concurrent creates may exceed `maxAgents`).
- Quota counts non-deleted agents with the account's `accountId`. Creation when `count >= maxAgents`, or when the account's status is not `active`, fails with a clear error; nothing is created or provisioned.
- Full control means the same per-agent powers a platform admin has today on an agent: settings, repos, allowlists, envs (including `ANTHROPIC_*`, `SLACK_*`, `GH_*`), crons (user-defined and system-cron editing as exposed today), tools, plugins, tokens, sync-manifest, connect-Slack, connect-GitHub, chat, members, delete. No reserved-key lockdown in Phase 1 (see Resolved Decisions).
- Members (explicit `AgentMember` rows) have the same full control for the agents they are listed on, including after the Feature 2 hardening.
- Claude credentials are bring-your-own: an Anthropic API key or Claude Code OAuth token supplied at create time.
- Slack and GitHub connection use the existing in-cluster provisioning flows (`slack-provisioning-service.ts`, `github-provisioning-service.ts`). Slack app creation requires the customer's own Slack App Configuration Token; GitHub uses a PAT, manual App entry, or the auto App manifest flow under the customer's own org. The new-agent form copy explains what the customer needs ready.
- Deleting an agent frees quota immediately and uses `deleteAgentFully()`.
- Agent type for account-created agents is fixed to `coding` in Phase 1.

**Acceptance Criteria**:
- [ ] An owner of an `active` account with `maxAgents = 2` and 1 agent can create a second agent; the third attempt fails with a quota error and creates no Agent row, K8s resources or credentials
- [ ] Two concurrent create requests with one remaining slot result in exactly one agent (verified by a test)
- [ ] Creating in a `suspended` or `trial_expired` account fails with a clear error
- [ ] An account-created agent has `accountId` set; an agent created by a platform admin has `accountId = null` unless explicitly assigned
- [ ] A user in account A cannot view, edit or delete an agent in account B via UI routes or JSON API (404/403)
- [ ] A member with an explicit `AgentMember` row can edit envs, tools, crons and plugins on that agent and nothing else
- [ ] Deleting an agent decrements the count so a new one can be created
- [ ] The create form shows remaining quota and prerequisites (Slack config token, GitHub org, Claude credential)

**Technical Considerations**: `createAgent()` (`admin/src/agents.ts`) is the single implementation behind the form and `POST /agents`; extend it rather than forking. Quota enforcement must happen inside the transaction (count under a lock, or a serializable check) to prevent over-allocation. Custom env/tool/plugin power on tenant agents is accepted by decision; containment is Feature 7.

**Source Map**:
- `admin/src/agents.ts` — `createAgent()` accountId and quota
- `admin/src/admin-ui.ts` — `/admin/agents/new`, `POST /admin/agents`, delete, `assertAgentAccess`, `resolveAccessibleAgents`
- `admin/src/agents-api.ts` — `POST /agents`, `DELETE /agents/:id`
- `admin/src/admin-ui-pages.ts` — new-agent form, agents list, hides admin-only cards appropriately for account owners
- `admin/src/agent-deletion.ts` — reused as-is

**Testing Strategy**: Layer: integration for quota/concurrency/atomicity against real Postgres with provisioner doubles; smoke for route contracts and cross-account denial.

---

### Feature 5: Platform admin Accounts view

**Priority**: Medium
**Description**: Platform admins manage accounts and see account context on existing views.

**Requirements**:
- New `/admin/accounts` page (admin only, flag-gated): table of accounts with owner email, member count, agents used / `maxAgents`, status, `trialExpiresAt`, created date.
- Account detail page: edit `name`, `maxAgents`, `plan`, `trialExpiresAt`; suspend / reactivate; list agents, members and pending invites; add or remove members and owners.
- Admin API equivalents under `/accounts` (admin bearer key or admin cookie only): `GET /accounts`, `GET /accounts/:id`, `PATCH /accounts/:id`, `POST /accounts` (admin-created accounts with owner email, quota and optional trial).
- The existing all-agents page gains an Account column for admins. Admins can assign or reassign an existing agent to an account.
- Non-admins never see other accounts, the Accounts page, or the Account column.

**Acceptance Criteria**:
- [ ] Admin can raise `maxAgents` from 0 to 3 on a self-created account and the owner can then create up to 3 agents
- [ ] `PATCH /accounts/:id` and `/admin/accounts*` return 403 for any non-admin session, with the flag on
- [ ] Admin can create an account via `POST /accounts` with an owner email, and the owner's first Google login lands in that account
- [ ] The all-agents page shows an Account column for admins and not for account users
- [ ] Reassigning an agent to an account updates `accountId` and the agent immediately appears in that account's scope

**Technical Considerations**: Mirror the admin-only gating and page patterns already used for `/admin/tasks` and members. An admin-created account pre-seeds an `AccountMember` owner row so first login joins it (treated like an accepted invite).

**Source Map**:
- `admin/src/admin-ui.ts`, `admin/src/admin-ui-pages.ts` — Accounts pages, Account column
- `admin/src/accounts-api.ts` (new), `admin/src/openapi-schemas.ts` — account routes and schemas
- `admin/src/api.ts` — route mounting

**Testing Strategy**: Layer: smoke — HTTP/page contracts with injected admin vs non-admin sessions; unit tests for page rendering.

---

### Feature 6: Account-level tenancy in the task-store and scoped Tasks/PRs/Sessions views

**Priority**: High
**Description**: Prevent tenants from seeing each other's tasks, PRs and sessions, even when they reference the same `org/repo`, and give account users scoped Tasks and PRs views.

**Requirements**:
- Add nullable `accountId` to `Task`, `PullRequest`, `Session` rollup and `VerificationCheck` (where applicable) in `task-store/prisma/schema.prisma`. Null means platform-owned (existing rows). Additive migration; no required backfill for existing rows.
- Agent tokens carry the agent's `accountId` (resolved via the existing scope resolver that calls admin `GET /agents/:id`). Creates stamp the token's `accountId`; reads and writes by an account-scoped token are filtered to that `accountId`. The existing `@@unique([repo, prNumber])` is widened to include `accountId` so two accounts can track the same PR number on the same repo name.
- Existing repo-based scoping is retained as an additional filter, not replaced.
- Admin's admin-token reads can filter by `accountId`. `/admin/tasks`, `/admin/tasks/:id`, `/admin/prs`, `/admin/prs/:id` become available to account users, filtered to their account (they are admin-only today); release/mutate actions remain scoped to that account's rows. Sessions lists/details use account scope instead of repo/agent-id intersection.
- A token with a null `accountId` and no admin scope cannot read rows that belong to an account.

**Acceptance Criteria**:
- [ ] Two accounts each with an agent on `org/repo` create tasks; each account's token lists only its own tasks
- [ ] Two accounts can each have a `PullRequest` for `org/repo#12` without a unique-constraint conflict
- [ ] An account user viewing `/admin/tasks` and `/admin/prs` sees only that account's rows; requesting another account's task or PR id returns 404
- [ ] Platform admin sees all rows; null-`accountId` rows remain visible to platform admin and to platform agents exactly as before (regression)
- [ ] The task-store migration is additive and `task check`/CI passes without a data backfill
- [ ] A session in another account is not visible in the sessions list or by direct URL (404)

**Technical Considerations**: This is the highest-complexity item; see Complexity Review in Resolved Decisions. It is a cross-service change (admin + task-store + agent token minting) and the `@@unique([repo, prNumber])` widening touches code paths used by review/patch/deploy claim logic. Known fragile areas: `/prs/claim` conflict handling, `scopeResolver` degradation path (fail closed to `[]`), and the admin task board scoping bug noted in prior work with non-admin tokens.

**Source Map**:
- `task-store/prisma/schema.prisma` — `accountId` columns, widened unique
- `task-store/src/auth.ts` — token scope includes `accountId`; `scopeResolver`
- `task-store/src/` task, PR and session routes and queries — account filtering
- `admin/src/admin-ui.ts` — `/admin/tasks*`, `/admin/prs*`, sessions routes
- `admin/src/session-scope.ts` — account-based visibility
- `admin/src/agents-api.ts` — expose `accountId` on `GET /agents/:id` for the resolver

**Testing Strategy**: Layer: integration — real Postgres in task-store with fixture tokens from two accounts proving isolation; smoke for the admin route filtering.

---

### Feature 7: Tenant pod isolation

**Priority**: High (required before the flag is enabled outside trusted users)
**Description**: Because tenants have full control (including shell via tools and cron `preCheck`), contain the blast radius of an agent pod with network and resource boundaries (Phase 1, "option A").

**Requirements**:
- A NetworkPolicy applied to tenant agent pods (selected by an `accountId`/tenant label the provisioner sets): egress allowed to the public internet, DNS, and the task-store, chat and admin services; denied to other agent pods, the Kubernetes API server and cluster-internal ranges otherwise. Ingress to agent pods denied except what the agent runtime requires. Platform agents (null `accountId`) are not affected.
- CPU limit and request set on tenant agent containers (today there is none); configurable via the existing `SHIPWRIGHT_K8S_AGENT_*` overrides.
- A per-account `ResourceQuota` sized from `maxAgents` (derived from per-agent request/limit values times `maxAgents`), created and updated by the provisioner when the account's `maxAgents` changes, and removed when the account has no agents.
- Chart additions (NetworkPolicy template and RBAC for the admin service account to manage ResourceQuota) with helm-unittest coverage and `values.schema.json` updates.

**Acceptance Criteria**:
- [ ] A pod labeled for tenant A cannot connect to a pod of tenant B nor to the Kubernetes API (verified by a policy test or a documented cluster-level smoke check)
- [ ] Tenant agent pods still reach the internet, Slack and GitHub, task-store, chat and admin (verified in the cluster smoke check)
- [ ] Tenant agent containers have a non-empty CPU limit; platform agents are unchanged
- [ ] Changing `maxAgents` from 2 to 4 updates the account's ResourceQuota accordingly
- [ ] `helm unittest` passes for the new templates and defaults render nothing when the flag is off
- [ ] `docs/deploy-kubernetes*.md` documents the new policy and quota behavior

**Technical Considerations**: There is no ResourceQuota, LimitRange or NetworkPolicy in the chart today, and the provisioner runs in a single namespace (`SHIPWRIGHT_K8S_NAMESPACE`). NetworkPolicy enforcement depends on the cluster CNI supporting it; this must be confirmed per provider and called out in the docs. Namespace-per-account is the named hardening phase (Out of Scope).

**Source Map**:
- `admin/src/agent-manifest.ts` — container resources, tenant labels
- `admin/src/agent-provisioner.ts`, `admin/src/main.ts` (`buildProvisioner`) — quota and policy lifecycle
- `charts/shipwright/templates/` — NetworkPolicy, RBAC (`agent-provisioning-rbac.yaml`)
- `charts/shipwright/values.yaml`, `values.schema.json`
- `docs/deploy-kubernetes-provisioning.md`, `docs/deploy-kubernetes-networking.md`

**Testing Strategy**: Layer: unit for manifest/label/quota generation and helm-unittest for templates; one documented cluster-level smoke check for policy enforcement (cannot be proven at unit level).

---

### Feature 8: Account status, suspension and trials

**Priority**: Medium
**Description**: Lock down and warn at the account level using the trial-expiry machinery already built per agent.

**Requirements**:
- `Account.trialExpiresAt` behaves like the agent-level field: a warning is sent 3 days before expiry (once, tracked by `trialExpiryWarnedAt`), and after expiry the account's `status` becomes `trial_expired`.
- Suspending (admin action) or `trial_expired` locks down all agents in the account using the existing lockdown semantics: crons disabled and Slack messages rejected with a "paused" notice. Nothing is deleted. Creation of new agents is blocked.
- Reactivating the account (admin sets `status = active`, clears or extends `trialExpiresAt`) re-enables Slack immediately (existing self-healing gate) and re-enables crons that lockdown disabled (this is new for accounts: lockdown records which crons it disabled so reactivation restores exactly those).
- Per-agent `trialExpiresAt` continues to work unchanged and can coexist with account state.

**Acceptance Criteria**:
- [ ] An account with `trialExpiresAt` 2 days away and a 3-day window gets exactly one warning
- [ ] After expiry, the sweeper sets `status = trial_expired`, disables all crons for the account's agents, and Slack messages to those agents get the paused reply
- [ ] Re-running the sweeper makes no duplicate PATCH calls and sends no duplicate notices
- [ ] Setting `status = active` and a future `trialExpiresAt` restores Slack handling immediately and re-enables exactly the crons the lockdown had disabled (not crons the user had disabled themselves)
- [ ] No `deleteAgentFully()` call occurs in any suspension or trial flow
- [ ] Agents with `accountId = null` and a per-agent `trialExpiresAt` behave exactly as before (regression)

**Technical Considerations**: Extend `trial-expiry-sweeper.ts`, `trial-expiry-warning-sweeper.ts` and `agent/src/agent-trial-expiry-ref.ts` rather than duplicating. The agent-side gate in `agent/src/slack.ts` needs to resolve "account suspended or expired" in addition to the agent's own `trialExpiresAt`. Restoring crons needs a way to remember which crons were disabled by lockdown (e.g. a nullable marker on `AgentCronJob`).

**Source Map**:
- `admin/src/trial-expiry-sweeper.ts`, `admin/src/trial-expiry-warning-sweeper.ts` — account-level handling
- `agent/src/agent-trial-expiry-ref.ts`, `agent/src/slack.ts` — account-aware gate
- `admin/prisma/schema.prisma` — lockdown marker on `AgentCronJob`
- `admin/src/agent-cron-jobs.ts` — re-enable on reactivation

**Testing Strategy**: Layer: integration — fixture accounts/agents against real Postgres with injected admin-API and Slack doubles; unit for the agent-side gate comparison.

---

## Technical Constraints

- Additive migrations only in both `admin` and `task-store`; existing and self-hosted data must be untouched.
- No behavior change when `SHIPWRIGHT_SELF_SERVE_ENABLED` is unset.
- Reuse `createAgent()` as the single creation path; do not fork provisioning logic.
- Follow the repo's test-isolation rules: no `mock.module()`, injected clocks, recorded fixtures, test layers by filename suffix; coverage gate 89–90%.
- `accountId` is never accepted from a client request body; it is derived from the authenticated session or token.
- Emails are lowercased on write and read; identity is the verified Google email.
- Config and chart changes require `docs/configuration.md` and `task check-config-docs` to stay green.

## Scope

**In Scope**:
- `Account`, `AccountMember`, `AccountInvite`, `Agent.accountId`, and the feature flag
- Auth hardening of the JSON API and account-scoped visibility in admin
- Google sign-in that joins via invite or creates an account; invites and member management
- Account-scoped agent create/configure/delete with per-account quota, full control for owners and members
- Platform admin Accounts view and API; admin-created accounts and quota/trial controls
- Account-level `accountId` in the task-store and scoped Tasks/PRs/Sessions views
- Phase 1 tenant isolation: NetworkPolicy, CPU limit, per-account ResourceQuota
- Account suspension and trial expiry using the existing lockdown model
- Bring-your-own Slack app, GitHub App/PAT and Claude credentials

**Out of Scope**:
- Payments, Stripe, invoicing, per-agent pricing (hooks: `Account.plan`, `maxAgents`)
- A public shared Slack app and public shared GitHub App (named later phase; requires multi-workspace OAuth, per-install token storage and event routing, and per-install tenancy)
- Namespace-per-account isolation (named hardening phase before public signup beyond trusted users)
- Okta-based self-serve signup; Okta behavior unchanged
- Moving the platform-admin role from env vars to the database
- Multiple accounts per email; account transfer between emails
- Any change for self-hosted / customer-infrastructure deployments (feature stays off)
- Agent types other than `coding` for self-serve accounts
- Usage metering or spend caps per account (the separate spend-caps work stands alone)

## Priorities & Sequence

1. **Feature 2 (auth hardening)** first and independently shippable: it fixes an existing issue and unblocks everything else.
2. **Feature 1 (model + flag)** next; Features 3–8 depend on it.
3. **Features 3, 4, 5** after 1 and 2: sign-in/invites, account agent management, admin Accounts view. 4 depends on 3's account resolution; 5 can run alongside 4.
4. **Feature 6 (task-store tenancy)** can start once Feature 1 lands (needs `accountId` on `Agent`); it must complete before the flag is turned on for any non-trusted user.
5. **Feature 7 (isolation)** can run in parallel with 3–6 and must complete before the flag is turned on for any non-trusted user.
6. **Feature 8 (suspension/trials)** after 1, 4 and the existing trial-expiry code; it can land after the first trusted-user rollout.

Gate for enabling the flag anywhere: Features 1, 2, 3, 4, 6 and 7 complete.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| 1. Account model and flag | integration | Constraints and migration against real Postgres; flag helper is unit |
| 2. Auth hardening | smoke | HTTP route contracts with injected session claims; pure scope helpers unit-tested |
| 3. Sign-in, invites, account creation | integration | Transactional create/join and concurrency against real Postgres; smoke for login route contracts |
| 4. Account-scoped agent management | integration | Atomic quota enforcement with provisioner doubles; smoke for cross-account denial |
| 5. Platform admin Accounts view | smoke | Admin-only route/page contracts |
| 6. Task-store tenancy | integration | Two-account fixture tokens against real Postgres prove isolation |
| 7. Tenant pod isolation | unit | Manifest, label and quota generation plus helm-unittest; one documented cluster smoke check for policy enforcement |
| 8. Suspension and trials | integration | Fixture accounts and agents with injected admin-API and Slack doubles |

## Resolved Decisions

- **Phase 1 Slack/GitHub model**: Bring-your-own Slack app and GitHub App/PAT, using the existing in-cluster provisioning flows. — Rationale: Reuses `createAgent()` and the connect flows; a shared public Slack/GitHub app needs multi-workspace OAuth, per-install token storage and event routing, which is a much larger change. Public shared apps are a named later phase.
- **Sign-in**: Google (Gmail) only for self-serve; Okta unchanged. — Rationale: Dan: "we actually support okta and gmail… expecting this to use gmail."
- **Account joining**: With an invite, the user joins the inviting account; without one, a new account is created with them as owner. — Rationale: Dan's explicit rule.
- **Quota scope and default**: Quota is per account (`maxAgents`); self-created accounts start at 0, configurable via `SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS`; users request a trial by emailing dan@app-vitals.com and an admin raises the quota. — Rationale: Dan: "Starts with 0 for now." No payment exists yet and compute cost is ours.
- **Credentials**: Customers bring their own Anthropic API key or Claude OAuth token. — Rationale: Dan's explicit answer; keeps token cost off us.
- **Tenant control level**: Owners and members have full control (envs, tools, plugins, crons, tokens, etc.) of agents they can access, with no reserved-key lockdown. — Rationale: Dan: "More control. Members should also have full control as well for resources that they have access to." Trade-off accepted: tenants can run arbitrary shell in their pods, so containment comes from Feature 7.
- **Isolation level**: Phase 1 uses NetworkPolicy, CPU limit and per-account ResourceQuota in the shared namespace. — Rationale: Dan chose option A. Namespace-per-account is a named hardening phase.
- **Task-store tenancy**: Add `accountId` to `Task`, `PullRequest`, `Session` (and `VerificationCheck`) in the task-store; do not rely on unique repo ownership. — Rationale: Dan chose the more robust option, which allows overlapping repo names safely.
- **Platform admin**: Keep `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` and `SHIPWRIGHT_ADMIN_API_KEYS` as the superuser in Phase 1; add an Accounts view. `AgentMember` stays; account members have access to all account agents by default. — Rationale: Keeps self-hosted deployments unchanged. Moving admin to the DB can be revisited. _(Can be revisited before plan-session.)_
- **One account per email**: An email belongs to at most one account in Phase 1. — Rationale: Simplifies sign-in resolution and the session scope; multi-account switching is a separate UX problem. _(Default chosen; can be revisited.)_
- **Agent type**: Self-serve agents are fixed to `coding`. — Rationale: Smallest surface for Phase 1; other types can be exposed later. _(Default chosen; can be revisited.)_
- **Feature flag**: `SHIPWRIGHT_SELF_SERVE_ENABLED`, default off, because the feature does not apply to customers who deploy to their own infrastructure. — Rationale: Dan's request that it be toggleable.
- **Payments**: Out of scope; `Account.plan` and `maxAgents` are the hooks. — Rationale: Dan: "let's not implement payments yet."
- **Complexity review — task-store tenancy (Feature 6)**: Kept as designed, flagged for engineering review before implementation. — Rationale: Cross-service change with a widened unique constraint that touches claim logic for review/patch/deploy; plan-session should split it into small, independently shippable tasks and add isolation tests first.
- **Complexity review — auth hardening (Feature 2)**: Kept as designed and sequenced first and standalone. — Rationale: Fixes a latent issue where any cookie session is API-admin; touches all `/agents/*` routes so it needs thorough regression tests.
- **Complexity review — isolation (Feature 7)**: Kept as designed, flagged for engineering review. — Rationale: NetworkPolicy enforcement depends on the cluster CNI; the plan must verify support per provider and include a cluster-level check.

## Success Criteria

- A new user signs in with Google, gets an account with `maxAgents = 0`, sees the request-a-trial message, and after an admin raises the quota can create and manage agents against their own Slack, GitHub and Claude credentials without any operator touching the agent.
- An invited user joins the inviting account on first login, and sees exactly that account's agents, sessions, tasks and PRs.
- Account A cannot see, query or modify anything belonging to account B through the admin UI, the JSON API or the task-store, including when both reference the same `org/repo`.
- A platform admin can create, inspect, resize, suspend and reactivate accounts from the admin UI and API.
- With `SHIPWRIGHT_SELF_SERVE_ENABLED` unset, a self-hosted deployment behaves exactly as before and all existing tests pass.
- `task ci` passes with no coverage regression, and the migrations are additive.

## Amendments from plan-session (2026-10-08)

Where these differ from the sections above, these win (details in `PLAN.md`):

- **Feature 7:** a per-account `ResourceQuota` is not possible in a shared namespace (quotas are per namespace). Per-account bounds are `maxAgents` × fixed per-pod limits, enforced in admin, plus a CPU limit on tenant pods. NetworkPolicy ships as a static, flag-gated chart template keyed on label `shipwright.dev/tenant="true"`.
- **Feature 6:** task-store `accountId` is `NOT NULL DEFAULT 'default'` (not NULL); `Session` is a real table and is keyed by `[accountId, slug]`; the `PullRequest` unique is `[accountId, repo, prNumber]`. Task ids stay globally unique and cross-account collisions return a generic 409.
- **Feature 1:** the task-store default account id is the constant `DEFAULT_ACCOUNT_ID = "default"`; `Agent.accountId` in admin stays nullable.
- **Feature 4:** elevated member powers (settings, members, delete) apply only when `SHIPWRIGHT_SELF_SERVE_ENABLED` is on.
- **Feature 8:** the admin web chat is also gated for suspended accounts.

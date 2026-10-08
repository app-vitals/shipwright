# Self-Serve Agent Provisioning — Plan

**Date**: 2026-10-08
**Session**: self-serve-agent-provisioning
**Repo**: `app-vitals/shipwright`
**Spec**: `PRODUCT-SPEC.md` (this folder). Where this plan and the spec differ, this plan wins (see "Amendments to the spec").
**Tasks**: `SSP-*` — 31 tasks, ~144h

## Technical design

### Admin: auth, scope, accounts
- **Fix first (SSP-1.1).** `api-auth.ts` marks every valid `admin_session` cookie `isAdmin=true`, ignoring the JWT claim. Read the claim; scope non-admin cookie sessions to `GET /agents`, `POST /agents` and `/agents/:id/**` for agents in their scope. Always on (bug fix).
- **Models (SSP-1.2).** `Account`, `AccountMember` (UNIQUE email, one account per email), `AccountInvite`, nullable `Agent.accountId`. Additive.
- **Scope (SSP-2.1).** `resolveCallerScope` resolves per request from the email: account agents (flag on) ∪ `AgentMember` agents. Account is *not* stored in the JWT (membership changes take effect immediately).
- **Sign-in (SSP-3.1).** `completeLogin` joins via a pending invite or auto-creates an account (owner) in one idempotent transaction; flag-gated; Google only.
- **Quota (SSP-4.1).** `createAgent` locks the account row (`SELECT … FOR UPDATE`) inside the existing transaction and counts agents. First row lock in `admin/`; tolerate undefined-tx test doubles.
- **Control (SSP-4.2/4.3).** Account users create/delete agents; access holders get settings/members/delete (flag on only, so existing platform members gain nothing).

### Task-store tenancy
- `accountId String NOT NULL DEFAULT 'default'` on `Task`, `PullRequest`, `Session`, `VerificationCheck` (`DEFAULT_ACCOUNT_ID = "default"`). Postgres fills the default on existing rows, so there is no NULL semantics and no separate backfill job.
- Unique keys: `PullRequest [accountId, repo, prNumber]` and `Session [accountId, slug]`, rolled out as add → migrate callers → drop old (SSP-6.1/6.3/6.4 and 6.1/6.7/6.9).
- **Sessions are a real table** keyed by `slug` only, upserted on every task write (`session-service.ts`); two accounts using one slug would share title/archive state and the reaper would cross accounts. Hence SSP-6.7.
- Scope resolver (`createScopeResolver`) returns `{repos, accountId}` from admin `GET /agents/:id` (no token column, so reassignment is live and needs no re-mint). Failure fails closed.
- Agent tokens see only their account; default-account agent tokens only `'default'`; admin tokens see all, with an optional `?accountId=` filter (admin tokens only).
- `listReady`/`listBlocked` load the whole task table to resolve dependencies; they must filter by account first (SSP-6.5) or tenants could satisfy each other's dependencies.
- `VerificationCheck` routes have no scoping today (existing cross-tenant gap); fixed in SSP-6.10.
- Admin fetchers use one admin token; admin filters server-side via `?accountId=` (SSP-6.8).

### Isolation (Phase 1, shared namespace)
- Tenant pods get label `shipwright.dev/tenant="true"` and a CPU limit (SSP-7.1); drift detection includes both so reassignment reconciles.
- A static, chart-shipped NetworkPolicy (SSP-7.2, off by default): egress to DNS, shipwright services and the internet minus private/link-local ranges (blocks other pods, node/metadata, API server); ingress only from admin. Needs a CNI that enforces NetworkPolicy. Verified on the cluster by a HITL task (SSP-7.3).

### Suspension and trials
- `AgentCronJob.lockdownDisabledAt` records exactly which crons lockdown disabled (SSP-8.1) so reactivation restores only those.
- Account sweepers + suspend/reactivate lifecycle (SSP-8.2); agent config gains `accountStatus` and the Slack gate (SSP-8.3); the admin web chat is gated too (SSP-8.4), since the existing trial gate covers Slack and crons only.

## Task table and dependency map

| Task | Title | Depends on | Model | Hrs | HITL |
|------|-------|-----------|-------|-----|------|
| SSP-1.1 | Honor session isAdmin and scope non-admin cookies in the JSON API | — | sonnet | 5 | |
| SSP-1.2 | Add Account, AccountMember, AccountInvite models and services | — | sonnet | 5 | |
| SSP-1.3 | Add self-serve feature flag, default-quota and contact env config | — | haiku | 2 | |
| SSP-2.1 | Resolve account-aware caller scope for admin UI and API | 1.1, 1.2 | sonnet | 4 | |
| SSP-3.1 | Join via invite or auto-create an account on Google sign-in | 1.2, 1.3, 2.1 | opus | 6 | |
| SSP-3.2 | Add account page: members, invites, last-owner guard, zero-quota message | 3.1 | sonnet | 5 | |
| SSP-3.3 | Notify operators when a self-serve account is created | 3.1 | haiku | 2 | |
| SSP-4.1 | Add accountId and race-safe quota enforcement to createAgent | 1.2 | opus | 5 | |
| SSP-4.2 | Let account users create and delete their own agents (UI and API) | 4.1, 2.1, 3.1, 1.3 | sonnet | 6 | |
| SSP-4.3 | Give agent-access holders full control of settings, members and delete (flag on) | 2.1, 1.3 | sonnet | 4 | |
| SSP-5.1 | Add admin-only /accounts API | 1.2, 1.3 | sonnet | 5 | |
| SSP-5.2 | Add admin Accounts pages and Account column on the agents list | 5.1, 2.1 | sonnet | 6 | |
| SSP-5.3 | Let admins assign or reassign an agent to an account | 5.1, 7.1 | sonnet | 4 | |
| SSP-6.1 | Add accountId (default 'default') and new unique keys to task-store schema | — | sonnet | 4 | |
| SSP-6.2 | Return accountId from the scope resolver and plumb it through task-store auth | 1.2, 6.1 | sonnet | 5 | |
| SSP-6.3 | Migrate PullRequest callers to the [accountId, repo, prNumber] key and stamp it | 6.1, 6.2 | opus | 6 | |
| SSP-6.4 | Drop the old PullRequest [repo, prNumber] unique | 6.3 | haiku | 1 | |
| SSP-6.5 | Scope Task reads and writes by accountId, incl. ready/blocked and dependencies | 6.2 | opus | 8 | |
| SSP-6.6 | Scope PullRequest reads and writes by accountId, incl. claimNext and reaper SQL | 6.2, 6.3 | opus | 8 | |
| SSP-6.7 | Key Sessions by account: upsert, get, list, update and retention reaper | 6.2 | opus | 7 | |
| SSP-6.9 | Drop the Session slug primary key | 6.7 | sonnet | 2 | |
| SSP-6.10 | Scope VerificationCheck reads and writes by account and repo | 6.2 | sonnet | 4 | |
| SSP-6.8 | Admin: scoped Tasks, PRs and Sessions views for account users | 6.5, 6.6, 6.7, 6.10, 2.1 | opus | 8 | |
| SSP-7.1 | Label tenant pods and apply a CPU limit in the agent manifest | 1.2 | sonnet | 4 | |
| SSP-7.2 | Add tenant NetworkPolicy to the Helm chart with docs | 7.1 | sonnet | 5 | |
| SSP-7.3 | Verify tenant NetworkPolicy enforcement on the cluster | 7.2 | haiku | 2 | ⚠ HITL |
| SSP-8.1 | Record which crons lockdown disabled and add a restore method | 1.2 | sonnet | 3 | |
| SSP-8.2 | Account trial expiry, warning, suspend and reactivate lifecycle | 8.1, 5.1 | opus | 8 | |
| SSP-8.3 | Gate Slack on account status in the agent runtime | 1.2 | sonnet | 4 | |
| SSP-8.4 | Gate the admin web chat on account status | 1.2, 2.1 | sonnet | 3 | |
| SSP-9.1 | Document self-serve provisioning for operators and customers | 4.2, 6.8, 7.2, 8.2 | haiku | 3 | |

```
[START] 1.1  1.2  1.3  6.1
  1.1+1.2 -> 2.1 -> 3.1 (also 1.3) -> 3.2, 3.3
  1.2 -> 4.1 -> 4.2 (also 2.1, 3.1, 1.3)
  2.1+1.3 -> 4.3
  1.2+1.3 -> 5.1 -> 5.2 (also 2.1);  5.1+7.1 -> 5.3
  6.1+1.2 -> 6.2 -> 6.5, 6.7 -> 6.9, 6.10
  6.1+6.2 -> 6.3 -> 6.4;   6.2+6.3 -> 6.6
  6.5+6.6+6.7+6.10+2.1 -> 6.8
  1.2 -> 7.1 -> 7.2 -> 7.3 (HITL)
  1.2 -> 8.1 -> 8.2 (also 5.1);  1.2 -> 8.3;  1.2+2.1 -> 8.4
  4.2+6.8+7.2+8.2 -> 9.1
```

**Flag gate:** do not enable `SHIPWRIGHT_SELF_SERVE_ENABLED` for anyone until 1.x–4.x, 6.x and 7.x (including HITL 7.3) are deployed.
**Deploy order constraints:** 6.3 must be merged *and deployed* before 6.4; 6.7 before 6.9. No bundles: every task has its own branch and PR.

## Breaking Change Safety

- `PullRequest` old unique `repo_prNumber` → add new unique (6.1), migrate all callers + tests (6.3), drop (6.4).
- `Session.slug` primary key → add `[accountId, slug]` unique (6.1), migrate callers (6.7), drop PK (6.9).
- New NOT NULL `accountId` on populated task-store tables uses a constant `DEFAULT 'default'` (metadata-only, fills every row); 6.1 requires a live-data check (zero NULLs, only `'default'`) recorded in the PR. Needs prod DB access, so the reviewer may need to run it.
- 1.1 narrows what non-admin cookie sessions may do against the JSON API (it is a bug fix); it must check no browser script depends on the old behavior.
- Everything else is additive. Safe to deploy standalone: yes, unless a task states otherwise.

## Amendments to the spec

1. **No per-account ResourceQuota.** A Kubernetes ResourceQuota is per namespace; with the agreed shared namespace it cannot be per account. Bounds come from `maxAgents` × fixed per-pod requests/limits (enforced in admin) plus a CPU limit on tenant pods. Per-account quotas come with namespace-per-account. Feature 7's quota criteria are superseded.
2. **Nullable `accountId` + sentinel.** Task-store tables use `accountId NOT NULL DEFAULT 'default'`; admin `Agent.accountId` stays nullable (null ⇒ `'default'`).
3. **Sessions** are an actual table and are keyed by account (6.7/6.9).
4. **Task id collisions:** task ids remain globally unique; account-scoped tokens get a generic 409 ("task id unavailable"). Namespacing ids is a follow-up.
5. **NetworkPolicy** ships as a static chart template keyed on a pod label rather than being created by the provisioner (no RBAC change).

## Decision Log

- Elevated member powers (settings, members, delete) apply only when the flag is on: existing platform AgentMembers gain no new power.
- JSON API cookie-scope fix is always on: it is a bug fix independent of the flag.
- Account resolved per request from email, not carried in the JWT.
- Scope resolver carries `accountId` (no token column); reassignment needs no token re-mint; resolver failure fails closed.
- Agent tokens for the default account see only `'default'` rows.
- Signup notification is a structured log plus best-effort push (SSP-3.3); no new integration.
- Tenant ingress allows only the admin service; verify during SSP-7.3 and widen if the runtime needs more.
- Reassigning an agent to an account does not move its historical task-store rows (documented).
- Contact email for trial requests defaults to dan@app-vitals.com (`SHIPWRIGHT_SELF_SERVE_CONTACT_EMAIL`).
- Timeline: the plan is ~144h; 6.x is the long pole and the riskiest area (claim logic, dependency resolution).

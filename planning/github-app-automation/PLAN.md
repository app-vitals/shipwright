# Plan Session: github-app-automation

Repo: app-vitals/shipwright (work spans app-vitals/agent and app-vitals/shipwright)
Spec: none (design agreed interactively with the maintainers, 2026-11-09)
Scope: Phases 1 and 2 are planned (Phase 2 section below). Phase 3 (reconcile repos, dry-run then commit) and Phase 4 (create the apps via manifest) are planned in later sessions and extend this one.

## Summary

Orgs under one GitHub Enterprise Cloud enterprise can have an agent's GitHub App installed, and its repos set, from the Shipwright admin, instead of by hand on GitHub. This phase adds the two admin-level GitHub Apps that make that possible, their configuration, and an install-on-org action. The whole feature is optional: with nothing configured, agent provisioning and management behave exactly as today.

## Decisions

- Every agent already has its own GitHub App (manifest flow). The two new apps are **admin-level** and belong to no agent:
  - **Installer app**, installed on the enterprise. Calls the enterprise organization-installations REST API to install agent apps on orgs (and, in Phase 3, add or remove repos on those installations).
  - **Lookup app**, read-only, installed on every org with all repositories. Answers what a given user can do on a given repo (Phase 3) so an agent's repos can be capped at its bound user's access.
  - Two apps for least privilege: the key that changes installations never reads member data, and the read-only key cannot change anything. A per-agent app cannot do the lookup because it only sees repos already in its installation.
- **One pair of apps per Shipwright deployment**, shared by all admins. No per-account storage.
- **Optional.** No `GitHubEnterpriseApp` rows means the feature is off and invisible.
- **Isolation exception.** Admin normally never calls GitHub with App credentials (multi-github-app-installations decision). The enterprise client is the one narrow exception; its keys are stored apart from agent credentials and never reach the agent config bundle or any agent-readable route.
- **Paste-credentials only** in this phase; no manifest-creation button for these two apps.
- **Reuse is by recipe, not by shared app.** A shared app's private key in every deployment could mint tokens for every customer's installations. Each deployment owns its pair; the docs publish the exact permission list so setup is reproducible.
- Reconcile (Phase 3) is dry-run then commit.

## Findings that shaped the design

- The platform (admin service, runtime, manifest provisioning, installations manager and snapshot) lives in `app-vitals/agent` and ships as `@app-vitals/agent-*`, pinned by shipwright. Almost all code goes there; shipwright gets docs and a pin bump (opened by the platform-release workflow).
- Prior sessions already shipped per-agent App provisioning (GAP, GAM) and multi-org installs (MGI: discovery, per-owner tokens, public-App option, installations snapshot and admin card, optional per-repo access probe). This phase builds on them and duplicates none.
- Encryption: `TokenCrypto` / `SHIPWRIGHT_ENCRYPTION_KEY` (AES-256-GCM, `AgentEnv` format) is reused. Differences: refuse to save a key when no encryption key is configured (the existing fallback stores plain text); strict decrypt with no legacy-plain-text fallback; a separate table so keys cannot reach the agent config bundle (AgentEnv rows flow into it). No key rotation (same limit as AgentEnv). Log scrubbing is name-based, so errors must never echo the PEM.
- Cassettes in this repo are hand-authored JSON (scenario to `{status, body}`) replayed through an injected `fetchFn`; there is no recording tooling. The client task authors them from GitHub's published REST OpenAPI description and the enterprise organization-installations docs page. The live check is the final HITL task.
- Enterprise endpoints (docs page): list installable organizations, list accessible repositories, list/install/uninstall installations, toggle repository access, add/remove repositories (up to 50 per call). The caller must be a GitHub App installed on the enterprise. Install is documented as accepting any valid, publicly available App, so private agent Apps are refused.
- No gate task of the "wait for @app-vitals/agent >= X" kind has ever run in the task store (the runbook and pin-check script shipped in XPF). GHE-1.6 is the first.

## Technical design

All of GHE-1.1 to 1.5 live in `app-vitals/agent`.

**Data (additive migration).** `GitHubEnterpriseApp`, primary key `role` (`installer` | `lookup`): appId, slug, enterpriseSlug (installer only), encrypted private key, last-validation status, timestamp and error. At most two rows. No row means off.

**Service.** `GitHubEnterpriseAppService`: save, delete, validate. Key encrypted on write via the injected `TokenCrypto`; never returned by any route (metadata and a "key set" flag only).

**Client.** `GithubEnterpriseClient`, injected `fetchFn` and `apiBase`: RS256 app JWT (admin has no signer today), find the enterprise installation and mint its token, list installable orgs, list an org's installations, install an App on an org. Typed errors distinguish permission, not found, validation, rate limit and server errors. Repo add/remove is added in Phase 3.

**API.** Status; PUT and DELETE per role; validate; list orgs; install on org. Install takes an agent id and resolves the target App's client id from its stored slug through the public `GET /apps/{slug}`; private Apps get a clear refusal. `openapi.json` regenerated.

**UI.** New admin settings page with an installer card and a lookup card (paste credentials, validate, status), plus an org list with install-lookup-app and install-agent-app actions. Visible to all admins; empty state when unconfigured. Agent provisioning pages unchanged.

**Docs.** New platform doc with the exact permission list for both apps and the isolation exception.

**Shipwright side.** Release gate, then a CLAUDE.md pointer and a composed-surface smoke assertion that the settings page appears in shipwright's composed admin (the wiring goes here if the platform page does not reach it automatically).

## Complexity risks accepted

- Request shapes and permission names come from docs and OpenAPI, not a live call. A mismatch surfaces at the final HITL verify and costs a small client patch.
- First-ever release-gate task; it is autonomous, stays pending or blocks itself on failure, and per the runbook escalates to HITL after 2h stuck.
- Admin gains its first GitHub-calling code with App credentials. Contained by the isolation exception above and a test that no agent-facing path can return the keys.

## Breaking change safety

Everything is additive (new table, new routes, new page). No renames, removals or constraint additions. Safe to deploy standalone: yes, for every task. Cross-repo: Expand (GHE-1.1 to 1.5, producer) then RELEASE GATE (GHE-1.6) then Migrate (GHE-1.7, consumer). The producer `feat:` commits cut the release; the `docs:` task alone would not.

## Test layers

Unit for the JWT signer, client and UI rendering; integration for the service on a real DB (including the encryption round-trip) and the client against cassettes; smoke for the admin routes via `app.request()`; content/smoke for the shipwright composed surface. No `mock.module()`, no global `fetch` overrides.

## Tasks

| ID | Repo | Title | Layer | Deps | Cx / model | Hrs | HITL |
|---|---|---|---|---|---|---|---|
| GHE-1.1 | app-vitals/agent | feat: add GitHubEnterpriseApp model and encrypted credential service | Database | — | 3 / sonnet | 4 | |
| GHE-1.2 | app-vitals/agent | feat: add GithubEnterpriseClient for enterprise app installation | Shared | — | 4 / sonnet | 6 | |
| GHE-1.3 | app-vitals/agent | feat: add admin API for enterprise app config, validate, orgs and install | API | 1.1, 1.2 | 4 / sonnet | 6 | |
| GHE-1.4 | app-vitals/agent | feat: add admin settings page for the enterprise GitHub apps | Frontend | 1.3 | 3 / sonnet | 5 | |
| GHE-1.5 | app-vitals/agent | docs: document enterprise GitHub apps and the admin isolation exception | Shared | 1.4 | 2 / haiku | 2 | |
| GHE-1.6 | app-vitals/shipwright | chore: wait for @app-vitals/agent-admin >= 1.3.0 in shipwright (RELEASE GATE) | Shared | 1.5 | 1 / haiku | 1 | |
| GHE-1.7 | app-vitals/shipwright | docs: point CLAUDE.md and docs index at enterprise GitHub apps | Shared | 1.6 | 2 / haiku | 2 | |
| GHE-1.8 | app-vitals/shipwright | chore: configure both apps in prod admin and verify on a real org | Shared | 1.7 | 2 / sonnet | 2 | HITL |

## Dependency map

```
[START]
  ├─ GHE-1.1 model + encrypted service (no deps)
  └─ GHE-1.2 client, hand-authored cassettes (no deps)
        └─ GHE-1.3 admin API (needs 1.1, 1.2)
              └─ GHE-1.4 admin settings page (needs 1.3)
                    └─ GHE-1.5 docs (needs 1.4)
                          └─ GHE-1.6 RELEASE GATE (needs 1.5)
                                └─ GHE-1.7 shipwright docs + composed-surface smoke (needs 1.6)
                                      └─ GHE-1.8 prod verify, HITL (needs 1.7)
```

## Phase 2 — Bind a GitHub username to an agent (planned 2026-11-10)

Scope: a platform admin binds a GitHub username to an agent and can preview what that user can reach. Identity binding only: no tokens are stored for the user, and nothing about the agent's installation or repos changes yet (that is Phase 3). All code is in `app-vitals/agent`; the one Shipwright task is a live check.

### Decisions

- **Binding is platform-admin only.** Admins already set up agents and configure members and the owner; the GitHub username joins them. `PATCH /agents/:id` is open to admins and session members, and `platform.ops` keys may call it, so `githubUsername` follows the `accountId` / `specialty` precedent with an extra `isAdmin` check. Session members, ops keys and agent keys get a 403. The preview route has the same gate.
  - Why: the platform does not verify that a username belongs to the person typing it. If a non-admin could set it, they could rebind the agent to a more privileged account and raise its ceiling.
  - An agent that holds the `*` admin key could rebind itself, and in Phase 3 apply a reconcile, which defeats the cap. The rule is also operational: agents do not get the `*` key. The docs say so.
- **A non-admin owner has no binding.** With no bound username Phase 3 reconcile does not run for that agent, and nothing changes. That is the safe default. Owner self-serve needs a verified GitHub identity (sign-in or device flow) and is a later phase.
- **Save validates syntax only** (GitHub login rules); there is no GitHub call on save, so saving works with nothing configured. The preview checks that the user exists and reports "user not found" there.
- **No second release gate.** The only Shipwright task here is HITL, and its first human step is the pin check, so a separate gate task adds nothing. (The Phase 1 gate, GHE-1.6, has not run yet at the time of writing.)
- **The field lives in the existing Owner & Anthropic identity card**, renamed "Owner & identities", not a new card. The card's GitHub row shows only when the enterprise apps are configured. The access preview is its own section below it.
- **Audit trail is a log line** with the caller's name. No new columns.
- A user can be bound to several agents (no uniqueness).
- **Unknown is never "none".** The resolver reports per-org status and a `complete` flag; a 403 or 429 marks the org partial. Phase 3 reuses it and relies on this.
- Push-capable means admin, maintain or write. Triage and read are not. Phase 3 caps the installation at push-capable repos.

### Findings that shaped the design

- Owner, members and the new username are three separate things. `ownerEmail` is unverified metadata for per-agent Anthropic identity (the provisioner requires it to create the service account and federation rule); nothing reads it for access. `AgentMember` is the access list (caller scope in admin, Slack gating). `githubUsername` is the identity whose access caps the agent's repos. It is one value per agent, so it cannot live on the member set.
- `ownerEmail` is set only at create (the session user, or an admin key whose name is an email). An agent-created agent via an admin key gets no owner, which fails provisioning in per-agent identity mode. That is an existing gap unrelated to this feature and is tracked separately.
- The Phase 1 client covers the installer role only. The lookup side (per-org installation token, repo listing, collaborator permission) is new here.
- Existing nullable-field pattern to follow: `trialExpiresAt` / `ownerEmail` (optional through the service types, PATCH body, response, OpenAPI and lib types), so shipwright's test doubles keep compiling.

### Technical design

**GHE-2.1 data and PATCH.** Nullable `Agent.githubUsername`, additive migration, no uniqueness. Stored lower-cased. Optional in the PATCH body, response, OpenAPI and `@app-vitals/agent-lib` types. Admin-only gate as above; syntax validation only; the change is logged with the caller name.

**GHE-2.2 lookup client.** Extends the Phase 1 client (or a sibling sharing the JWT signer): per-org installation token for the lookup app, paginated installation repository listing, `GET /repos/{o}/{r}/collaborators/{user}/permission` (role mapped to admin, maintain, write, triage or read), user lookup, org membership. Hand-authored cassettes from GitHub's OpenAPI description; typed errors for 403, 404, 422, 429 and 5xx; no token in any error or log.

**GHE-2.3 resolver.** `UserRepoAccessResolver`: for each org where the lookup app is installed and the org is installable, list repos and resolve the bound user's level with bounded concurrency. Per-org status (ok, lookup app not installed, rate-limited, partial, error) and a `complete` flag. A 403 or 429 stops that org's remaining calls and marks it partial.

**GHE-2.4 route.** `GET /agents/:id/github-access`, platform-admin only, read-only, no persistence. Checks the user exists first. Returns an unconfigured status when the apps are not set up and a clear 4xx when no username is bound. No tokens in responses or logs. `openapi.json` regenerated.

**GHE-2.5 UI.** The GitHub identity row in the Owner & identities card (username field, save and clear) shown only when the enterprise apps are configured, plus a "Preview access" section with a table grouped by org, per-org status badges and a "partial results" warning.

**GHE-2.6 docs.** Binding and preview, the admin-only rule and why, the push-capable levels, unknown-is-not-none, and the "agents do not hold the `*` key" note. States what owner, members and GitHub username are each for.

**GHE-2.7 live verify (HITL, shipwright).** First step: `scripts/check-platform-pin.sh` to confirm the release is pinned and deployed. Then bind a real user to a test agent, run the preview and compare against GitHub's own view of that user.

### Breaking change safety

Everything is additive: a nullable column, an optional PATCH field and a new route. The `@app-vitals/agent-lib` contract change is optional-only, so there is no Migrate task. Safe to deploy standalone: yes, for every task. The producer `feat:` commits cut the release.

### Test layers

Integration for the migration and set/clear, and for the resolver and client against cassettes (complete, partial and rate-limited runs); unit for syntax validation, role mapping and the unknown-is-not-none rule; smoke via `app.request()` for the PATCH gating (admin 200; session member, ops key and agent key 403) and the preview route; unit and smoke for the card. No `mock.module()`, no global `fetch` overrides.

### Complexity risks accepted

- Preview cost is one permission call per repo. Bounded concurrency and the partial status keep it safe; there is no caching in v1.
- The lookup app's permission needs (Administration vs Metadata read for the collaborator lookup) are settled in GHE-1.2 and confirmed live in GHE-2.7.

### Phase 2 tasks

| ID | Repo | Title | Layer | Deps | Cx / model | Hrs | HITL |
|---|---|---|---|---|---|---|---|
| GHE-2.1 | app-vitals/agent | feat: add githubUsername to Agent with admin-only PATCH and response support | Database | — | 3 / sonnet | 4 | |
| GHE-2.2 | app-vitals/agent | feat: add lookup-app org token, repo listing and collaborator permission to the GitHub client | Shared | GHE-1.2 | 4 / sonnet | 5 | |
| GHE-2.3 | app-vitals/agent | feat: add completeness-aware UserRepoAccessResolver | Shared | GHE-2.2, GHE-1.1 | 4 / sonnet | 5 | |
| GHE-2.4 | app-vitals/agent | feat: add github-access preview route for the bound GitHub user | API | GHE-2.1, GHE-2.3, GHE-1.3 | 4 / sonnet | 5 | |
| GHE-2.5 | app-vitals/agent | feat: add GitHub identity row and access preview to the agent detail page | Frontend | GHE-2.4 | 3 / sonnet | 5 | |
| GHE-2.6 | app-vitals/agent | docs: document username binding and the access preview | Shared | GHE-2.5 | 2 / haiku | 2 | |
| GHE-2.7 | app-vitals/shipwright | chore: bind a real user to an agent and verify the access preview | Shared | GHE-2.6, GHE-1.8 | 2 / sonnet | 2 | HITL |

### Phase 2 dependency map

```
[PHASE 1]  GHE-1.1 (merged), GHE-1.2 (merged), GHE-1.3, GHE-1.8
[START]
  ├─ GHE-2.1 githubUsername column + admin-only PATCH (no deps)
  └─ GHE-2.2 lookup-app client calls (needs GHE-1.2)
        └─ GHE-2.3 UserRepoAccessResolver (needs 2.2, GHE-1.1)
              └─ GHE-2.4 preview route (needs 2.1, 2.3, GHE-1.3)
                    └─ GHE-2.5 identity row + preview UI (needs 2.4)
                          └─ GHE-2.6 docs (needs 2.5)
                                └─ GHE-2.7 live verify, HITL (needs 2.6, GHE-1.8)
```

## Later phases

- **Phase 3 — Reconcile:** plan (dry-run diff for the installation and the agent config) then apply (installation first, then config; idempotent; audit entry with caller). Platform-admin only for both. Never remove from an incomplete or failed listing (the resolver's `complete` flag); cap removals; agent repos are always a subset of installation repos; newly accessible repos are not auto-added; open tasks and PRs on removed repos are surfaced to the admin, not auto-blocked. An agent with no bound username is skipped.
- **Phase 4 — Create the apps from admin (manifest):** lookup app via the manifest flow (a normal org app; reuse `buildAgentAppManifest` and `exchangeManifestCode` with a different permission set); the installer app too if GitHub allows it. GitHub's manifest docs mention only personal and organization targets, nothing for enterprise or enterprise-level permissions, so assume paste-only for the installer until GHE-1.8's live check says otherwise. Extends the Phase 1 settings page; can start once GHE-1.4 is merged.
- **Later, unscheduled:** a scheduled drift check; webhook triggers; verified owner self-serve binding (GitHub sign-in or device flow); unifying owner, members and GitHub identity into one model; filing the admin-key-created-agent owner gap; a sessions-page signal for a PR with red CI and no patch activity.

## Phase 1 follow-ups: findings from the GHE-1.8 live check (planned 2026-11-11)

Scope: polish and gaps found while configuring both apps on a real enterprise and test org. All code is in `app-vitals/agent`; the one Shipwright task is a live check. Everything is additive: no existing contract changes.

### What the live check showed
- Both apps validated; the lookup app installed on a test org via admin; a public agent App installed; a private App was refused with a clear message. No request-shape or permission-name divergence from the docs.
- The installer needs `enterprise_organization_installation_repositories` (write) for Phase 3, and the lookup likely needs Organization Members read. The doc and validation only cover the first permission of each.
- A validate 404 was an uninstalled installer app; the message does not say so.
- The settings cards give no field locations, no enterprise-required notice, and no hint to ignore the callback/OAuth/token-expiry options.
- The key field is paste-only; a `.pem` file upload is wanted.
- An agent provisioned with only `GH_APP_SLUG` installs fine but its installations card stays empty: the runtime needs `GH_APP_ID` and a key to discover and report.
- Admin already stores `GH_APP_CLIENT_ID` in the agent env for manifest-provisioned agents, but install ignores it and resolves the slug through the public `GET /apps/{slug}`. That is why a private App is refused.

### Design
- **Install and Check agent** prefer the agent's stored `GH_APP_CLIENT_ID`, falling back to the public lookup. The private-App refusal stays for agents with neither. Whether GitHub's endpoint accepts a private App is unverified and is settled by the live check (GHE-1.14).
- **Validate** returns warnings, not failures, for the two newly documented permissions, so deployments configured before this change stay valid. The installation-lookup 404 gets a specific message.
- **Settings page**: intro reworded, enterprise-required notice, per-card setup steps and field locations, `.pem` file upload beside paste (still never echoed). Role names `installer` and `lookup` stay; cards gain a plain descriptor.
- **Docs**: permission tables, setup steps, the installations-card prerequisite.
- **No release gate task.** Releases move quickly; the HITL task's first step is the pin check, as in GHE-2.7.

### Tasks
| ID | Repo | Title | Layer | Deps | Cx / model | Hrs | HITL |
|---|---|---|---|---|---|---|---|
| GHE-1.9 | app-vitals/agent | feat: install and check-agent prefer the agent's stored GH_APP_CLIENT_ID | API | — | 3 / sonnet | 3 |  |
| GHE-1.10 | app-vitals/agent | feat: specific validate errors and permission warnings for both apps | API | — | 3 / sonnet | 4 |  |
| GHE-1.11 | app-vitals/agent | feat: add enterprise-required notice, setup steps and field guidance to the settings cards | Frontend | GHE-1.10 | 3 / sonnet | 4 |  |
| GHE-1.12 | app-vitals/agent | feat: accept a .pem file upload on the key field | Frontend | GHE-1.11 | 3 / sonnet | 3 |  |
| GHE-1.13 | app-vitals/agent | docs: update enterprise apps doc for both permissions, setup and the installations-card prerequisite | Shared | GHE-1.9, GHE-1.12 | 2 / haiku | 2 |  |
| GHE-1.14 | app-vitals/shipwright | chore: verify private-app install via stored client id and the installations card (HITL) | Shared | GHE-1.13 | 2 / sonnet | 2 | HITL |

GHE-1.11 and GHE-1.12 share the branch `feat/ghe-settings-cards-guidance`. GHE-2.7 is unaffected; its prerequisite GHE-1.8 is done.

### Breaking change safety
All additive: a new fallback in install, warnings alongside the existing validate result, new page copy and an optional upload. Safe to deploy standalone: yes, for every task.

### Addendum: GHE-2.7 finding (2026-11-11)

The live access-preview check passed for admin and push-capable levels, and showed partial-results with "lookup app not installed" when the lookup app was uninstalled. It also showed a gap: with the lookup app installed on **selected repositories only**, the preview silently lists just those repos with no warning, so it looks complete. The doc requires all repositories, but nothing enforces or flags it.

**GHE-2.8** (app-vitals/agent, API + Frontend, no dependencies, 3 / sonnet, 3h): when the lookup app's installation on an org has `repository_selection: "selected"`, the resolver marks that org partial with a reason, and the preview shows it in the existing partial-results banner; the lookup card guidance gains one line saying all repositories are required. Additive; an `all` installation is unchanged. Tests: resolver unit test and integration cassette for a selected installation, plus a preview page assertion; nothing retired. Unverified before the task starts: that the call the resolver makes returns `repository_selection` for the lookup app's own installation, and the exact preview wording.

## Phase 3: Reconcile an agent's repos against its bound user (planned 2026-11-11)

Scope: from admin, plan (read-only dry run) then apply a reconcile that brings an agent's installation repos and configured repos in line with what its bound GitHub user can push to. Platform admin only. Code is in `app-vitals/agent`, plus one task in `app-vitals/shipwright` for the open-work port. Builds on the Phase 2 resolver and the GHE-2.8 selected-repositories signal.

### Findings
- `Agent.repos` holds `owner/repo` entries. `POST /agents/{id}/repos` unions `org/repo` entries and returns 400 when two repos share a basename (clones are keyed by basename), so the planner must reject colliding adds.
- Repos can be edited today by session members (`PATCH /agents/:id`, gate `isAdminOrSessionMember`) and, via `POST`/`DELETE /agents/{id}/repos`, by the admin, the agent's own key or `platform.ops`. Decision: reconcile is the enforcer. Write-time enforcement is not added in this phase; a member can add a repo the bound user cannot push to and the next plan shows it as a removal. The docs say so.
- The resolver already returns per-org status, a `complete` flag and push-capable roles. The installer client has no repository list, add or remove methods yet; the installer app already holds `enterprise_organization_installation_repositories` write.
- There is no audit table in the platform schema.
- The platform admin has no task-store access; shipwright's composed admin does. Open tasks and PRs on removed repos are therefore listed and blocked through an optional port that shipwright implements.

### Design
1. **Desired agent repos** = current agent repos intersected with repos the bound user can push to. Removals only: newly accessible repos are never added on their own. An admin may name repos to add; each must be push-capable for the user and must not collide by basename.
2. **Installation repos first**: add any agent repo missing from the installation, remove any the agent no longer has. Agent repos are always a subset of installation repos.
3. **Never remove on an incomplete listing**: an org whose resolver result is partial or failed, or whose lookup installation is `selected` (GHE-2.8), is skipped for removals.
4. **Removal cap**: apply refuses more than 10 removals unless the admin confirms. It limits the blast radius of a wrong username binding, a lookup misconfiguration or a resolver bug; a human reviews the diff, so it is a second guard, and it matters more once something automatic applies reconciles.
5. **Inert when unbound or unconfigured**: no bound username, or enterprise apps not configured, behaves as if the feature did not exist: the Reconcile section does not render, the routes return `skipped` with a reason (no error, no audit entry, no change).
6. **Idempotent**: a second apply with no drift does nothing.
7. **Open work on removed repos**: the plan lists open tasks and PRs on the repos to be removed via an optional port (additive; without it nothing is listed or blocked). On apply, after the installation and agent config are updated, the port blocks them with `blockedReason: "repo removed from agent by GitHub reconcile (owner/repo)"`. The admin's confirm on apply is the confirmation.
8. **Audit**: a new `GitHubReconcileAudit` table (agent, caller, plan hash, diff, result, time), additive migration. Apply re-plans server-side and refuses when the plan differs from the hash the admin saw.
9. **Routes**: `POST /agents/:id/github-reconcile/plan` (read-only) and `.../apply` with `{planHash, addRepos?, confirmRemovals?}`, platform-admin only.

### Tasks
| ID | Repo | Title | Layer | Deps | Cx / model | Hrs | HITL |
|---|---|---|---|---|---|---|---|
| GHE-3.1 | app-vitals/agent | feat: add installation repository list, add and remove to the installer client | Shared | — | 3 / sonnet | 4 |  |
| GHE-3.2 | app-vitals/agent | feat: add reconcile planner that never removes from incomplete listings and rejects basename collisions | Shared | GHE-2.8, GHE-3.1 | 4 / sonnet | 5 |  |
| GHE-3.3 | app-vitals/agent | feat: add reconcile audit table, apply service with removal cap, and the open-work port | Database | GHE-3.2 | 4 / sonnet | 5 |  |
| GHE-3.4 | app-vitals/agent | feat: add admin-only reconcile plan and apply routes | API | GHE-3.3 | 3 / sonnet | 4 |  |
| GHE-3.5 | app-vitals/agent | feat: add Reconcile section to the agent detail page, hidden when inert | Frontend | GHE-3.4 | 3 / sonnet | 4 |  |
| GHE-3.6 | app-vitals/shipwright | feat: implement the reconcile open-work port to list and block tasks and PRs on removed repos | Shared | GHE-3.10 | 3 / sonnet | 4 |  |
| GHE-3.7 | app-vitals/agent | docs: document reconcile, its safety rules, the audit entry and the member-edit caveat | Shared | GHE-3.5, GHE-3.6 | 2 / haiku | 2 |  |
| GHE-3.8 | app-vitals/shipwright | chore: reconcile a real agent against a real user and verify the diff and blocks (HITL) | Shared | GHE-3.7 | 2 / sonnet | 2 | HITL |
| GHE-3.9 | app-vitals/agent | feat: add an optional open-work seam to AdminExtensionServices and wire it into the reconcile service | API | GHE-3.4 | 3 / sonnet | 3 |  |
| GHE-3.10 | app-vitals/shipwright | chore: wait for @app-vitals/agent >= X in shipwright (HITL) | Shared | GHE-3.9 | 1 / haiku | 1 | HITL |

### Breaking change safety
All additive: new client methods, a new table, new routes, an optional port, a new page section. GHE-3.6 consumes the open-work port through a producer, release gate, consumer chain: GHE-3.3 exported the port type, but no task gave a host a way to supply it, so GHE-3.9 adds the optional `openWork` seam on `AdminExtensionServices` (after GHE-3.4's routes), GHE-3.10 is the HITL release gate, and GHE-3.6 bumps `agent-*` to that release and supplies the port. Added 2026-11-11 after GHE-3.6 blocked on the missing seam; GHE-3.4 was already in progress and is unchanged. Safe to deploy standalone: yes, for every task.

## Scope decision: Phase 4 and the unscheduled items are not planned (2026-11-11)

Phases 1 to 3 and their follow-ups are the complete feature: both apps configured and verified, an agent's App installed on enterprise orgs, and an agent's repos reconciled against its bound user. Phase 4 (creating the apps from admin via the manifest flow) is only a convenience over the paste path, which is verified live, and the installer's manifest route for enterprise-level permissions is untested. The "Later phases" list (Phase 4, scheduled drift check, webhook triggers, verified owner self-serve binding, unifying owner/members/GitHub identity, the admin-key-created-agent owner gap, the sessions-page red-CI signal) is not scheduled and nothing depends on it. Revisit only if a live finding in GHE-1.14 or GHE-3.8 makes one of them necessary.

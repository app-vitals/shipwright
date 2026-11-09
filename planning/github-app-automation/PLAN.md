# Plan Session: github-app-automation

Repo: app-vitals/shipwright (work spans app-vitals/agent and app-vitals/shipwright)
Spec: none (design agreed interactively with the maintainers, 2026-11-09)
Scope: Phase 1 of three. Phases 2 (bind a GitHub user to an agent) and 3 (reconcile repos, dry-run then commit) are planned in later sessions and extend this one.

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

## Later phases

- Phase 2: bind a GitHub username to an agent (identity only, no tokens); validate user and org membership; read-only preview of resolved repo access via the lookup app.
- Phase 3: reconcile as plan (dry-run diff for the installation and the agent config) then apply (installation first, then config; idempotent; audit entry). Never remove from an incomplete or failed listing; cap removals; agent repos are always a subset of installation repos; newly accessible repos are not auto-added; open tasks and PRs on removed repos are surfaced to the admin, not auto-blocked.
- Later: a "create via manifest" button for the two apps; a scheduled drift check.

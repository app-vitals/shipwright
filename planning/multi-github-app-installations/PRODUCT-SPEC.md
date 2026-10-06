# Multiple GitHub App Installations per Agent — Product Specification

**Date**: 2026-10-02
**Session**: multi-github-app-installations
**Status**: Draft

## Overview

One Shipwright agent can use a single GitHub App installed on several GitHub orgs and act across all of them as one bot identity. The motivating case is a customer running one agent per engineer, where the engineers' repos span multiple GitHub orgs. Existing single-installation and PAT agents are unaffected.

## Problem Statement

An agent holds one `GH_APP_INSTALLATION_ID`, one installation token, one token file, and a credential helper scoped only to `github.com`. A per-engineer App therefore reaches only one org. Moving the customer's repos into one org is impractical, and one agent per org per engineer defeats the goal of a single agent with cross-org context. The install flow also overwrites the stored installation id, and an App created through today's manifest flow is private, so GitHub won't let it be installed on other orgs. Separately, several plugin commands call `gh api /user`, which GitHub rejects for installation tokens, so they can't resolve the agent's own login on an App-authenticated agent.

## Users & Context

- **Engineers** at the customer each have an agent. They ask it to work across repos in several orgs.
- **Customer org admins** install the engineer's App on their orgs, either on GitHub directly or through Shipwright. They may have no access to the Shipwright admin UI.
- **Operators** (App Vitals, assisting) configure agents and diagnose why an org isn't working. Manual, env-var-only setup must work with no admin UI.

---

## Features

### Feature 1: App-authenticated agents resolve their own login

**Priority**: High (ships first; independent of the rest)
**Description**: Replace `gh api /user` in the plugin commands with the same GraphQL `viewer` lookup that `check-helpers.ts` already uses, so review, patch, merge, deploy and review-staged work for App-authenticated agents.

**User Stories**:
- As an engineer with an App-authenticated agent, I want review, patch, merge and deploy to identify the agent's own login so that self-review and patch-scope checks work.

**Requirements**:
- The five call sites (`review.md`, `patch.md`, `merge.md`, `deploy.md`, `review-staged/SKILL.md`) resolve the login through the existing normalized lookup (`name[bot]` becomes `app/name`).
- PAT behavior is unchanged: a PAT agent resolves the same login as today.
- Under an installation token the same bot appears in three forms: GraphQL `viewer.login` is `<slug>[bot]`, `gh pr view --json author` is `app/<slug>`, and GraphQL PR and review authors are the bare `<slug>`. Every comparison of the agent's own login against a PR or review author compares a canonical form (strip `app/` and `[bot]`, lowercase) on both sides.
- Comparison sites include `compute-unaddressed-findings.ts` (`isSelfCleanApprove`, `isSupersededBySelfReview`, `hasUnaddressedFindings`), `review.md` (`selfReview`, the unresolved-comment jq), the `patch.md` scope check, the `merge.md` and `deploy.md` own-PR checks, `plugins/shipwright/scripts/compute-unresolved-comment-check.ts` (`currentUser` and `prAuthor` comparisons), the `review.md` Step 14 live pre-check jq (`.author.login != $currentUser`, the fresh-comment exception), and `agent/src/check-review.ts` (`hasFreshNonAgentComment` against `currentUser`). A repo-wide grep for `author.login` comparisons confirms the list during MGI-1.2/1.3. The login written to the task store by `deploy.md` keeps its existing `app/<slug>` form.

**Acceptance Criteria**:
- [ ] No `gh api /user` or `gh api user` remains in the five files.
- [ ] A content test asserts each of the five resolves the login via the GraphQL viewer path.
- [ ] A unit test using the three observed forms (`<slug>[bot]`, `app/<slug>`, `<slug>`) shows they canonicalize to the same value, and a PAT login passes through unchanged apart from lowercasing.
- [ ] A unit test with a bot-reviewing-a-bot-authored-PR fixture shows the self-clean-approve, supersession and unaddressed-findings logic match the bot's own reviews.
- [ ] Existing `*.content.test.ts` suites for those files pass unchanged.
- [ ] Fresh-comment case: with the agent's `currentUser` in `app/<slug>` form and its own review and comments authored as the bare `<slug>`, `hasFreshNonAgentComment` and the `review.md` Step 14 pre-check treat them as the agent's own, so `reviewedAt` is not bumped and the PR is not re-selected every tick.

**Technical Considerations**: Reuse `getCurrentUser()` in `plugins/shipwright/scripts/check-helpers.ts`. Verified read-only against a real installation token after the PRD session: `gh api /user` returns 403, and the three login forms above differ with no two matching. A bot review on a bot-authored PR was not observed, so the self-review case is covered by fixtures plus the end-to-end task.

**Source Map**:
- `plugins/shipwright/commands/review.md` (line 114)
- `plugins/shipwright/commands/patch.md` (line 60)
- `plugins/shipwright/commands/merge.md` (line 58)
- `plugins/shipwright/commands/deploy.md` (line 103)
- `plugins/shipwright/skills/review-staged/SKILL.md` (line 44)
- `plugins/shipwright/scripts/check-helpers.ts`
- `plugins/shipwright/scripts/compute-unresolved-comment-check.ts`
- `agent/src/check-review.ts`

**Testing Strategy**: Layer: content for the markdown, plus unit for any script — no new I/O boundary.

### Feature 2: Multi-installation token manager

**Priority**: High
**Description**: The agent discovers its App's installations and maintains a token for each, with one refresh timer in total.

**User Stories**:
- As an engineer, I want my agent to authenticate to every org that has installed its App so that it can work across them without config edits.
- As an operator, I want a fully manual setup (App id, key, optional pinned installation id) to work with no admin UI.

**Requirements**:
- Discovery uses `GET /app/installations` (App JWT), paginated at 100 per page.
- An installation is used only if its owner appears in the agent's repo scope (case-insensitive), or it is pinned by `GH_APP_INSTALLATION_ID`.
- When scope has not yet synced, the agent uses the pinned installation only. It never treats unknown scope as empty.
- A pinned id wins over a discovered id for the same owner. The default installation is the pinned one, else the lowest installation id.
- If discovery fails, the agent falls back to the pinned installation and keeps the last good list. It never blocks startup.
- An installation is marked broken on a non-null `suspended_at` or any 403, 404 or 422 from token minting. Other installations keep working.
- Discovery re-runs on the existing config-sync tick, and the result is cached.
- Token files are written atomically (temp file, then rename).
- Refresh runs on a single timer regardless of installation count. `setupGitHubAuth` is not re-invoked.
- The GitHub-auth start gate changes from "all three env vars" to "App id and key, plus a pin or discovery".
- The token manager emits an event for every installation outcome (token minted, mint failed with status class, discovered, no longer present) so Feature 4 can subscribe to it.
- Agents with only today's three env vars, or only a PAT, behave exactly as before.

**Acceptance Criteria**:
- [ ] With a pinned id and no discoverable others, the agent behaves identically to today, and the existing `github-app-auth` and `setup-github-auth` suites pass unchanged.
- [ ] With App id and key only, an integration test using recorded fixtures discovers two installations and mints a token for each.
- [ ] An installation whose owner isn't in scope and isn't pinned is ignored.
- [ ] A pinned id overrides a discovered id for the same owner.
- [ ] A fixture with a suspended installation marks it broken while the other keeps a valid token.
- [ ] A discovery failure leaves the previous installation list in place and doesn't throw.
- [ ] Refresh creates exactly one interval for N installations.
- [ ] Token files are written via rename (asserted in a test).
- [ ] Discovery pagination is covered by a multi-page fixture.
- [ ] A test asserts the manager emits an outcome event for each of mint success, mint failure, discovered and removed.

**Technical Considerations**: Generalize `GitHubTokenManager` to a map keyed by installation id. Two processes (`entrypoint-main` and `index.ts`) each run a manager and write the same files, so writes must be atomic and the design should keep a single writer where possible. No hard-coded `ghs_` or token-length assumptions were found, and tests should keep it that way. Listing installations needs only the App JWT; confirm against GitHub's docs via a recorded fixture in the first task.

**Source Map**:
- `agent/src/github-app-auth.ts`
- `agent/src/setup-github-auth.ts`
- `agent/src/github-auth-startup.ts`
- `agent/src/github-auth-deps.ts`
- `agent/src/entrypoint-main.ts`
- `agent/src/index.ts` (config-sync tick)
- `agent/src/agent-repos-ref.ts`
- `agent/src/cutover-validate.ts`
- `docs/configuration-agent.md`

**Testing Strategy**: Layer: integration — calls GitHub through an injected `fetchFn` with `FixedClock` and cassettes; pure selection and merge functions get unit tests.

### Feature 3: Owner-aware token routing

**Priority**: High (depends on Feature 2)
**Description**: `git`, `gh` and clones use the token for the target repo's owner.

**User Stories**:
- As an engineer, I want my agent to clone, push and open PRs in any in-scope org without manual token switching.

**Requirements**:
- The git credential helper uses `credential.https://github.com.useHttpPath=true`, takes the owner from the `path` it receives (with or without `.git`), and returns that owner's token.
- The `gh` wrapper chooses the token from, in order: `-R`/`--repo`/`--repo=`, a `repos/<owner>/...` or `/repos/...` API path, the positional argument of `gh repo clone`, the current directory's git remote, then the default installation.
- Routing logic is a pure, unit-tested TypeScript resolver, and the shell scripts stay thin shims.
- Clones use the correct token.
- If an owner has no usable token, the error names the org.
- When two orgs have a same-named repo, adding it is rejected with a clear error. The check also covers an existing `repos/<name>` whose remote has a different owner. The `repos/<repo>` and `worktrees/<repo>-<branch>` layout is unchanged.
- With a single installation, behavior is identical to today.

**Acceptance Criteria**:
- [ ] Unit tests cover every owner-resolution input form above, including `.git` and non-`.git` paths and the fallbacks.
- [ ] A real-subprocess integration test runs the credential helper with a two-owner token fixture and asserts the right token per owner.
- [ ] A real-subprocess integration test runs the `gh` wrapper against a stub `gh` and asserts the right `GH_TOKEN` per case, including the default fallback for `gh api graphql`.
- [ ] `computeMissingClones` or its caller rejects a cross-org name collision with an error naming both repos.
- [ ] An existing directory whose remote owner differs is detected as a collision.
- [ ] A single-installation agent's helper and wrapper output is byte-identical to today's.

**Technical Considerations**: The wrapper scripts are on the hot path of every `gh` and `git` call, so keep the resolver fast. The plugin itself never clones and needs no change as long as `repos/<repo>` stays unique. Owner-less calls such as `gh search` fall back to the default installation, which is acceptable because it is the same App identity everywhere.

**Source Map**:
- `agent/scripts/bin/gh`
- `agent/scripts/bin/git-credential-shipwright.sh`
- `agent/Dockerfile` (PATH and chmod)
- `agent/src/sync-config-clone.ts`
- `lib/clone-plan.ts`
- `agent/src/setup-github-auth.ts` (credential config)

**Testing Strategy**: Layer: unit for the resolver and collision logic; integration for the wrappers (real subprocess — the existing exception, as with `run-with-budget`).

### Feature 4: Installation status reporting and admin visibility

**Priority**: Medium (depends on Feature 2)
**Description**: The agent's token manager reports installation state to the admin API automatically as part of the token flow, and admin displays it on the agent detail page. This follows the existing agent work-queue snapshot pattern (agent-reported, one row per agent). Admin never calls GitHub or the agent, and nothing requires the LLM agent to report anything manually.

**User Stories**:
- As an operator, I want to see which orgs an agent can reach and which are broken so that I can diagnose failures without agent log access.

**Requirements**:
- Per installation: owner login, installation id, state (in scope, discovered but not in scope, broken, pinned), last error (status class and a short sanitized reason), and `reportedAt`. No tokens, key material or raw response bodies.
- The reporter subscribes to the token manager's outcome events (Feature 2). It posts a full snapshot when an installation's state changes (ok to broken, broken to ok, discovered, removed), so a mint failure at refresh time is reported when it happens.
- It also posts a low-frequency heartbeat on the existing refresh cycle so `reportedAt` stays fresh. It does not post on every successful refresh with no change.
- A snapshot replaces the previous one, so an installation no longer present is removed.
- A failed or slow post never blocks or fails token minting. It is fire-and-forget with a log line.
- Admin provides write and read endpoints scoped to the agent (same auth as the work-queue route), backed by a one-row-per-agent snapshot table that is deleted with the agent. The payload schema is closed, so unknown fields such as tokens are rejected. The admin OpenAPI spec is regenerated.
- The admin agent detail page reads the snapshot from its own database. If there is no snapshot, the card is omitted. Admin shows the last-reported time so staleness is visible.

**Acceptance Criteria**:
- [ ] A smoke test shows the write endpoint rejects a request that isn't from the owning agent's token.
- [ ] A smoke test shows a second snapshot replaces the first, removing a dropped installation.
- [ ] An integration test shows a mint failure at refresh time produces a snapshot update marking that installation broken, without waiting for discovery.
- [ ] An integration test shows a later successful mint clears the broken state.
- [ ] A test shows a successful refresh with no state change posts nothing other than the heartbeat.
- [ ] A test shows the reporter throwing or timing out doesn't change token-manager behavior.
- [ ] A test asserts no token or key material appears in the posted payload.
- [ ] A unit test renders the admin card for in-scope, not-in-scope and broken states, plus an empty state and a stale `reportedAt`.
- [ ] No admin code path reads the App private key for the purpose of calling GitHub, and no admin route calls the agent.
- [ ] The admin OpenAPI spec is regenerated and CI's checks pass.

**Technical Considerations**: This adds an admin Prisma model and migration. Reuse `work-queue-reporter.ts`, `agent-work-queue.ts` and the work-queue routes as the pattern. No new admin dependency (`@octokit/auth-app` is not added to admin), and no task-store changes.

**Source Map**:
- `admin/prisma/schema.prisma` (+ migration)
- `admin/src/` (new snapshot service), `admin/src/agents-api.ts` (routes), `admin/openapi.json`
- `admin/src/admin-ui.ts` (agent detail page)
- `admin/src/admin-ui-pages.ts` (new card)
- `admin/src/main.ts` (service wiring)
- `agent/src/github-app-auth.ts` (event hook; see Feature 2)
- `agent/src/` (new reporter)
- `docs/agent-api-resources.md`

**Testing Strategy**: Layer: smoke for the routes, integration for the Prisma service (DB-gated) and the agent reporter, unit for rendering.

### Feature 5: Multi-org connect flow

**Priority**: Medium
**Description**: The manifest flow can create an App installable on several orgs, and an admin can add further orgs without overwriting the installation.

**User Stories**:
- As a customer admin, I want to install an engineer's App on another org through Shipwright so that the agent can use it.

**Requirements**:
- The connect form has an "installable on multiple orgs" option. On creates the manifest with `public: true`, off keeps `public: false`. The default is off.
- The manifest flow also stores a non-secret `GH_APP_SLUG` env var. Manually pasted Apps have none, so their agent page points at the docs instead of showing the button.
- An "Add another org" action redirects the browser to `https://github.com/apps/<GH_APP_SLUG>/installations/new`.
- The setup-URL callback no longer overwrites `GH_APP_INSTALLATION_ID` once one is stored. It shows an "install received" page and makes no GitHub call.
- Docs explain the manual "Make public" flip for existing Apps, and the first task verifies on a throwaway App what happens to existing installs before the docs promise anything.
- First-install behavior on a single-org agent is unchanged.

**Acceptance Criteria**:
- [ ] A unit test shows the manifest builder emits `public: true` only when the option is on.
- [ ] A smoke test shows the callback leaves a stored installation id unchanged and returns a success page.
- [ ] A smoke test shows a first-time callback with no stored id still stores it.
- [ ] A smoke test shows the "Add another org" route redirects to the App's install URL for the agent's slug.
- [ ] Docs describe the flip and its verified effect on existing installs.
- [ ] The manual-paste and PAT flows pass their existing tests unchanged.

**Source Map**:
- `admin/src/github-app-provisioning-client.ts`
- `admin/src/github-provisioning-service.ts`
- `admin/src/admin-ui.ts` (connect-github, callback and installed routes)
- `admin/src/admin-ui-pages.ts` (cards at roughly 1426-1460)
- `docs/configuration-agent.md`, `docs/agent-ops.md`

**Testing Strategy**: Layer: smoke for the routes, unit for the manifest builder and page markup. An e2e test is added only if the flow becomes a new page.

### Feature 6: Org-admin installs directly on GitHub

**Priority**: Medium (depends on Feature 2; docs after Feature 5)
**Description**: A customer org admin installs the engineer's App from github.com with no Shipwright access, and the agent picks it up.

**User Stories**:
- As a customer org admin, I want to install the engineer's App on my org from GitHub without Shipwright access so that the agent can work in my org.

**Requirements**:
- No Shipwright-side action is needed beyond the owner being in the agent's repo scope.
- Docs give org admins the steps. An install of an out-of-scope owner shows as "discovered, not in scope".

**Acceptance Criteria**:
- [ ] An integration test with a fixture containing an installation not created through admin shows it used once its owner is in scope, and ignored before.
- [ ] Docs include the org-admin install steps and note the up-to-one-sync-interval delay.

**Technical Considerations**: Only works for an App that is public (see Feature 5). Reuses the Feature 2 discovery path.

**Source Map**:
- `docs/configuration-agent.md`
- Feature 2 files

**Testing Strategy**: Layer: integration — same fixture-backed discovery path as Feature 2.

---

## Technical Constraints

- Agents with today's three env vars or only a PAT must behave identically, and existing suites must pass unchanged.
- One bot identity per agent: one App, many installations.
- Polling only, no webhook receiver.
- Admin must not use App credentials to call GitHub and must not trigger anything through the agent.
- Tests ship in the same PR at the right layer. No `mock.module()` and no `global.fetch` overrides. Use injected `fetchFn`, `Clock` and cassettes.
- New env vars follow `GH_APP_*` and pass `check-config-docs`. Secret-valued vars go in `lib/secret-env-vars.ts`.
- Nothing customer-specific (org names, company name) in the repo, tests or fixtures.
- `setupGitHubAuth` is not re-invokable. Refresh stays on a single timer.
- github.com only.

## Scope

**In Scope**:
- Features 1 to 6 above.

**Out of Scope**:
- GitHub Enterprise Server or any non-github.com host (assumed, since not answered).
- A webhook receiver and `installation.created` events.
- Multiple different Apps per agent.
- Code that migrates existing private Apps to public.
- Shared or pooled Apps across agents, and the open provisioning repo-access decision.
- Changes to the PAT path or merging PAT and App auth.
- Changes to `repos/<repo>` or worktree layout beyond collision detection.
- Per-installation billing, quotas or rate-limit management.
- The repo picker and auto-adding repos to an agent's scope.
- Any admin-to-GitHub or admin-to-agent calls.

## Priorities & Sequence

Feature 1 is independent and ships first. Feature 2 precedes Features 3, 4 and 6. Feature 5 is independent of the runtime work. Every task must be deployable standalone and inert until an agent actually has a second installation in scope.

## Testing Strategy

| Feature | Layer | Rationale |
|---------|-------|-----------|
| 1. Own-login resolution | content + unit | Prompt-markdown change over an existing helper; no new I/O. |
| 2. Token manager | integration (+ unit) | Calls GitHub via injected `fetchFn`/`Clock` with cassettes. |
| 3. Routing | unit + integration | Pure resolver is unit; the wrapper scripts need real-subprocess tests. |
| 4. Status reporting | smoke + integration + unit | Routes, DB-gated service and agent reporter, card rendering. |
| 5. Connect flow | smoke + unit | Route contracts and manifest builder. |
| 6. Direct install | integration | Same fixture-backed discovery path as Feature 2. |

## Resolved Decisions

- **One App, many installations**: a per-engineer App is installed on multiple orgs. — Rationale: gives the customer a single identifiable bot per engineer.
- **Public Apps for multi-org**: created with `public: true` via an option, default private. — Rationale: GitHub only allows installs on other accounts for public Apps.
- **Discovery default**: `GET /app/installations`, with an optional `GH_APP_INSTALLATION_ID` pin that wins on same-owner conflict. — Rationale: simplest, and keeps existing setups unchanged.
- **Trust filter**: use an installation only if its owner is in repo scope or pinned. — Rationale: an install by someone else must never grant the agent anything.
- **Default installation**: pinned, else lowest installation id. — Rationale: deterministic.
- **Discovery failure**: fall back to pinned plus last good list. — Rationale: never break a working agent.
- **Broken installations**: non-null `suspended_at` or 403/404/422 on mint. — Rationale: GitHub's docs don't state the suspended response, so the check is broad.
- **Cadence**: the existing config-sync tick, cached, paginated. — Rationale: matches today's no-restart activation.
- **No kill-switch env var**: rely on backward-compatibility rules and tests. — Rationale: "don't break things" is met by compatibility tests, not a flag.
- **Start gate**: App id and key plus a pin or discovery. — Rationale: discovery-only agents must be able to start.
- **Atomic token writes**. — Rationale: two processes write the same token files. _(Recommended in the Phase 2b review; can be revisited.)_
- **Routing in a TypeScript resolver, thin shell shims**. — Rationale: untested bash owner-parsing on every `gh`/`git` call is fragile. _(Recommended; can be revisited.)_
- **Collisions rejected, layout unchanged**. — Rationale: a silent same-name clone could push to the wrong customer's repo. _(Recommended; can be revisited.)_
- **Public flip documented, not coded; verified first**. — Rationale: the manifest only applies at creation, and GitHub's docs don't say what happens to existing installs. _(Recommended; can be revisited.)_
- **Admin never uses App credentials**: admin keeps storing the key as today but makes no GitHub or agent calls. — Rationale: isolation from customer environments (Dan).
- **Status via the admin API and database**: the agent reports a replace-all snapshot, admin reads it from its own database. — Rationale: matches the existing work-queue snapshot pattern, needs no task-store model, OpenAPI or MCP changes, and the row is deleted with the agent (revised during plan-session from the originally drafted task-store design; approved by Dan). _(Defaults chosen here, can be revisited: snapshot replace-all, no tokens or keys stored, `reportedAt` shown for staleness.)_
- **Reporting driven by token-manager events**: state-change posts plus a heartbeat, not a separate pass. — Rationale: reports failures when they happen and needs no manual step (Dan).
- **No local status file**. — Rationale: the admin card replaces it.
- **`gh api /user` fix is in scope** as Feature 1. — Rationale: the identity success criterion can't be met without it (Dan).
- **Canonical login comparisons**: strip `app/` and `[bot]` and lowercase on both sides of every own-login comparison. — Rationale: verified that an installation token yields three different forms of the same bot (Dan's verification run).
- **`GH_APP_SLUG` stored by the manifest flow**: needed to build the "Add another org" URL. — Rationale: the slug was previously discarded after the install URL was built.
- **Repo picker dropped**. — Rationale: it required admin to mint installation tokens.
- **github.com only**. — Rationale: assumed because the question went unanswered. _(Can be revisited before plan-session.)_

External blockers: none.

## Success Criteria

**Outcome**:
- One per-engineer App installed by the customer's admins on two or more orgs lets a single agent clone, read, branch, push and open PRs across all of them, and PRs show the one bot identity everywhere.
- Adding or removing an org install on GitHub shows up in the agent and in the admin card within one sync interval, with no restart or env edit.
- A fully manual setup (App id and key, or a pinned id) works with no admin UI.
- Review, patch, merge and deploy work for an App-authenticated agent.

**Technical**:
- Agents on today's single-triple or PAT config pass existing suites unchanged.
- With two orgs installed, fixture-backed tests show each `git` and `gh` call using the matching org's token, and refresh uses exactly one timer.
- A broken installation is reported by org name while the others keep working.
- `task ci` is green, including config-docs, banned-strings and coverage gates, and docs are updated.

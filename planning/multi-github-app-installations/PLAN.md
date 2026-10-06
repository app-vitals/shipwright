# Plan Session: multi-github-app-installations

Repo: app-vitals/shipwright
Spec: planning/multi-github-app-installations/PRODUCT-SPEC.md

## Summary

One per-engineer GitHub App, installed on several customer orgs, lets a single agent work across all of them as one bot identity. This plan also fixes own-login resolution for App-authenticated agents. Every task is additive and deployable standalone, and behavior stays identical to today until an agent actually has a second installation in scope.

## Findings that shaped the design

- Today an agent has one `GH_APP_INSTALLATION_ID`, one token file, one `GH_TOKEN`, and a credential helper keyed on `github.com` with no owner dispatch. `setupGitHubAuth` is not safely re-invokable (each call leaks a refresh interval).
- The agent runs two processes (`entrypoint-main` and `index.ts`) that each hold a token manager and write the same token file.
- Admin has no App-JWT signing code, and admin must not use App credentials to call GitHub or trigger the agent (isolation decision).
- Under an installation token one bot appears in three login forms: GraphQL `viewer.login` is `<slug>[bot]`, `gh pr view --json author` is `app/<slug>`, GraphQL PR and review authors are the bare `<slug>`, and `gh api /user` returns 403. This was verified read-only against a real installation token. A bot review on a bot-authored PR was not observed.
- The existing agent-reported snapshot precedent is `agent/src/work-queue-reporter.ts` posting to the admin API (`AgentWorkQueueSnapshot`, one row per agent, cascade-deleted). `VerificationCheck` is written by plugin markdown, not an agent process, so it is not the model for Feature 4.
- The manifest flow discards the App slug after building the install URL, so "Add another org" needs a stored `GH_APP_SLUG`.

## Technical design

**Agent runtime (Features 2, 3)**
- `GitHubTokenManager` is untouched. New `agent/src/github-installations.ts` holds `discoverInstallations()` (paginated `GET /app/installations`, App JWT only, injected `fetchFn`), a pure `selectInstallations()` (scope-or-pin filter, pinned wins on same owner, default is the pin else the lowest installation id, suspended flagged, unsynced scope means pinned-only), and `GitHubInstallationsManager`, which composes one `GitHubTokenManager` per installation and owns a single refresh timer.
- `setupGitHubAuth` is called once. The manager's `reconcile()` is called from the existing config-sync tick through a process-wide ref, so no interval leaks. Credential-helper and bot-identity config only need the App JWT, so they are set at setup even with zero installations.
- App auth engages only if a pin exists or discovery finds at least one usable installation. Otherwise the PAT path runs as today (a gate of "id plus key" alone would break PAT agents that also have App credentials).
- Token files: `gh-token` stays the default installation's token (single-install behavior byte-identical). Per-owner files live in `gh-token.d/<lowercase-owner>`, derived from `GH_TOKEN_FILE` (no new env var), written only when two or more installations are usable. All writes are temp file plus rename, mode 0600. Owner names are validated against the GitHub owner pattern.
- Routing: the credential helper sets `useHttpPath`, extracts the owner from `path` (with or without `.git`) and reads `gh-token.d/<owner>` when that directory exists, otherwise behaves as today. The `gh` wrapper calls a Bun resolver only when `gh-token.d` exists. Resolution order: `-R`/`--repo`/`--repo=`, `repos/<owner>/...` API path (or full API URL), the `gh repo clone` positional, the cwd remote, then the default installation. Owner-less calls fall back to the default.
- Collisions: `findRepoNameCollisions()` in `lib/clone-plan.ts`; the clone sync skips the later colliding repo and any repo whose existing folder has a different-owner remote; admin rejects colliding repo lists with a 400. The `repos/<repo>` and `worktrees/<repo>-<branch>` layout is unchanged.

**Status reporting (Feature 4)**: the manager exposes state through `onChange`. A reporter (same shape as `HttpWorkQueueReporter`) posts a replace-all snapshot to a new admin route when the state signature changes or a 30-minute heartbeat elapses. It is built only in `index.ts`, never throws, and sends no token or key. Admin adds an `AgentGitHubInstallationsSnapshot` model and migration, a service, `PUT`/`GET /agents/{id}/github-installations` (closed payload schema), and an agent-detail card.

**Admin connect flow (Feature 5)**: a `public` option on the manifest builder plus a form checkbox (default off); the manifest flow stores a non-secret `GH_APP_SLUG`; the installed callback stops overwriting a stored installation id; an "Add another org" redirect is shown only when the slug exists.

**Own-login fix (Feature 1)**: a standalone canonical-login helper (strip `app/` and `[bot]`, lowercase), applied on both sides of every own-login comparison in `compute-unaddressed-findings.ts`, `review.md`, `patch.md`, `merge.md` and `deploy.md`, plus `compute-unresolved-comment-check.ts`, the `review.md` Step 14 pre-check jq and `agent/src/check-review.ts`. `deploy.md` keeps writing the `app/<slug>` form to the task store.

**Docs**: new `docs/github-multi-org.md` (`configuration-agent.md` is already 224 lines), a `GH_APP_SLUG` row, a `CLAUDE.md` reference line.

## Complexity risks accepted

- Two processes write the same token files: atomic renames make racing safe, and only `index.ts` reports.
- The wrapper scripts have no tests today: real-subprocess integration tests are added.
- Bash path parsing is limited to the credential helper's `owner/repo(.git)` split; everything harder lives in the unit-tested resolver.
- GitHub's docs do not state the suspended-installation mint response: "broken" is keyed on `suspended_at` or any 403, 404 or 422.

## Test layers

Unit for selection, resolver, collision and login logic; integration for the token manager, reporter, token files and wrapper subprocesses (real subprocess, the existing `run-with-budget` precedent); smoke for admin routes; unit for the admin card; content for command markdown. No `mock.module()` and no global `fetch` overrides.

## Dependency map

```
[START]
  ├─ MGI-1.1 canonical login helper (no deps)
  │     └─ MGI-1.2 canonicalize comparisons (needs 1.1)
  │           └─ MGI-1.3 five commands use helper (needs 1.2)
  ├─ MGI-2.1 discovery + selection (no deps)
  │     └─ MGI-2.2 installations manager (needs 2.1)
  ├─ MGI-2.3 atomic token-file layer (no deps)
  │     └─ MGI-2.4 wire into startup (needs 2.1, 2.2, 2.3)
  │           ├─ MGI-3.2 credential helper + gh wrapper routing (needs 2.3, 2.4, 3.1)
  │           └─ MGI-4.2 agent status reporter (needs 2.4, 4.1)
  ├─ MGI-3.1 gh owner resolver (no deps)
  ├─ MGI-3.3 collision detection, lib + agent (no deps)
  │     └─ MGI-3.4 admin repos validation (needs 3.3)
  ├─ MGI-4.1 admin snapshot storage + route (no deps)
  │     └─ MGI-4.3 admin card (needs 4.1)
  ├─ MGI-5.1 public manifest option + GH_APP_SLUG (no deps)
  │     └─ MGI-5.2 callback no-overwrite + Add another org (needs 5.1)
  └─ MGI-5.3 HITL verify private-to-public flip (no deps)

MGI-6.1 docs (needs 2.4, 3.2, 4.3, 5.2, 5.3)
MGI-6.2 HITL end-to-end on two real orgs (needs 1.3, 3.2, 3.4, 4.2, 4.3, 5.2, 6.1)
```

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| MGI-1.1 | — | 1.2 | |
| MGI-1.2 | 1.1 | 1.3 | |
| MGI-1.3 | 1.2 | 6.2 | |
| MGI-2.1 | — | 2.2, 2.4 | |
| MGI-2.2 | 2.1 | 2.4 | |
| MGI-2.3 | — | 2.4, 3.2 | |
| MGI-2.4 | 2.1, 2.2, 2.3 | 3.2, 4.2, 6.1 | |
| MGI-3.1 | — | 3.2 | |
| MGI-3.2 | 2.3, 2.4, 3.1 | 6.1, 6.2 | |
| MGI-3.3 | — | 3.4 | |
| MGI-3.4 | 3.3 | 6.2 | |
| MGI-4.1 | — | 4.2, 4.3 | |
| MGI-4.2 | 2.4, 4.1 | 6.2 | |
| MGI-4.3 | 4.1 | 6.1, 6.2 | |
| MGI-5.1 | — | 5.2 | |
| MGI-5.2 | 5.1 | 6.1, 6.2 | |
| MGI-5.3 | — | 6.1 | ⚠ HITL |
| MGI-6.1 | 2.4, 3.2, 4.3, 5.2, 5.3 | 6.2 | |
| MGI-6.2 | 1.3, 3.2, 3.4, 4.2, 4.3, 5.2, 6.1 | — | ⚠ HITL |

MGI-3.2 depends on 2.4 because both edit `setup-github-auth.ts`; MGI-1.3 depends on 1.2 because both edit `review.md`.

## Tasks

| Task | Title | Layer | Hours | Complexity | Model |
|------|-------|-------|-------|-----------|-------|
| MGI-1.1 | Add canonical login helper | Shared | 3 | 2 | haiku |
| MGI-1.2 | Canonicalize own-login comparisons in findings logic, comment-check script, check-review.ts and review jq | Shared | 5 | 3 | sonnet |
| MGI-1.3 | Resolve own login via the helper in five commands | CLI | 4 | 3 | sonnet |
| MGI-2.1 | Add installation discovery and selection | Background | 5 | 4 | sonnet |
| MGI-2.2 | Add GitHubInstallationsManager | Background | 8 | 5 | opus |
| MGI-2.3 | Add atomic token-file layer | Background | 4 | 3 | sonnet |
| MGI-2.4 | Wire installations manager into startup | Background | 8 | 5 | opus |
| MGI-3.1 | Add gh owner resolver | CLI | 4 | 3 | sonnet |
| MGI-3.2 | Route credential helper and gh wrapper by owner | CLI | 8 | 4 | sonnet |
| MGI-3.3 | Detect cross-org repo name collisions | Shared | 4 | 3 | sonnet |
| MGI-3.4 | Reject colliding repos in admin | API | 4 | 3 | sonnet |
| MGI-4.1 | Add installation snapshot storage and route | Database | 6 | 4 | sonnet |
| MGI-4.2 | Add agent installations status reporter | Background | 5 | 3 | sonnet |
| MGI-4.3 | Add admin installations card | Frontend | 4 | 3 | sonnet |
| MGI-5.1 | Add public-App option and GH_APP_SLUG | API | 5 | 3 | sonnet |
| MGI-5.2 | Keep installation id on callback and add Add another org | API | 5 | 3 | sonnet |
| MGI-5.3 | Verify private-to-public flip keeps installations | CLI | 1 | 1 | haiku |
| MGI-6.1 | Document multi-org GitHub App setup | Shared | 4 | 2 | haiku |
| MGI-6.2 | Verify end to end on two real orgs | CLI | 3 | 1 | haiku |

Per-task descriptions and acceptance criteria (including each test-decision bullet) are on the queued task records.

## Breaking Change Safety

All tasks are additive and safe to deploy standalone. The three behavior changes are guarded:
- Relaxed start gate (MGI-2.4): existing suites pass unchanged, PAT agents with App credentials and zero installations stay on the PAT path.
- Atomic token writes (MGI-2.3): same file content and path, only the write mechanism changes.
- Installed callback no-overwrite (MGI-5.2): a first install with no stored id still stores it.
No renames, removals or constraint additions on existing tables. The one new table (MGI-4.1) is additive.

## HITL scan

Two Type A tasks: MGI-5.3 and MGI-6.2 (human acts in GitHub settings and on real orgs). No task edits `.claude/**`, adds a workflow secret, or backfills data. MGI-1.1 from the first-pass breakdown (verify bot login forms) was completed by a human-run verification and is recorded above, so it is not queued.

## Decision Log (soft defaults)

- Transient mint errors (5xx or network) are logged and retried, not marked broken.
- The earlier-listed repo wins a name collision and the later one is skipped.
- The status card goes stale after 90 minutes (three missed heartbeats).
- An owner with no token in multi-mode fails with a message naming the org and does not fall back to the default token.
- The legacy provisioning wizard is untouched.
- Feature 4 storage moved from task-store to the admin database (approved).
- `GH_APP_SLUG` is added so "Add another org" can build the install URL (approved).

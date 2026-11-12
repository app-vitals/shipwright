# Plan: cold-run-first-pr-quickstart

Repo: app-vitals/shipwright · Source: planning/cold-run-first-pr-quickstart/PRODUCT-SPEC.md

## Technical design

**Chosen option: B — one-command local task store.**

- `plan-session`, `dev-task`, `review`, `merge`, `patch`, `hitl` and 4 more commands (10 files under `plugins/shipwright/commands/` reference `SHIPWRIGHT_TASK_STORE_*`) call the store over HTTP. The store is a Hono + Prisma service that needs only Postgres (`DATABASE_URL_SHIPWRIGHT_TASK_STORE`), auto-runs `prisma migrate deploy` on boot, and seeds an admin token from `TASK_STORE_SEED_ADMIN_TOKEN` (`task-store/src/main.ts`). It is already published as `ghcr.io/app-vitals/shipwright-task-store`. Everything B needs exists; it just has no newcomer-facing wrapper.
- New `scripts/local-store.sh` (+ `task store:local` alias) writes a compose file to a temp/state dir, boots Postgres + the published task-store image, waits for readiness, mints an unscoped token via `POST /tokens`, and prints/writes `export SHIPWRIGHT_TASK_STORE_URL=... SHIPWRIGHT_TASK_STORE_TOKEN=...`. Idempotent; `--down` tears it down.
- Install-command fix is mostly mechanical. Single source of truth is `site/src/consts.ts` (`INSTALL_CMD`); `brand/tokens.json` is the brand-side source. Two-line form is presented as a multi-line `<pre>` block (site) and two stacked lines in templates/slides; the copy button copies both lines.
- Clean-box CI: new `.github/workflows/quickstart-clean-box.yml`, empty `CLAUDE_CONFIG_DIR`, installs the `claude` CLI, runs `claude plugin marketplace add` + `claude plugin install shipwright@shipwright`, asserts the plugin is listed, then boots the local store via `scripts/local-store.sh` and asserts create/list of a task over HTTP. Cannot cover `/shipwright:plan-session` / `/shipwright:dev-task` themselves (need an authenticated model session and a GitHub target repo, no secrets in PR CI); the job states this in its header and summary. Triggers: `release`, and PRs/pushes touching quickstart, README, plugin manifest, `scripts/local-store.sh`.
- Marketplace consideration: option B changes no existing interface — all additive. Breaking Change Scan: the INSTALL_CMD rewrite touches only string literals and the 6 site Playwright specs that assert them; updated atomically in the same task.

### Why not A or C
- **A (plugin-only):** every command embeds store curl calls (status transitions, claims, PR records). A file-backed mode means a second store implementation or conditional logic in 10 commands plus their content tests — well over a week and a long-lived fork of semantics. Rejected.
- **C (docs only):** requirement 5 cannot be met honestly; today a newcomer must hand-assemble Postgres, env vars and a seed token.

### Gap vs. Goal
Option B meets the 15-minute goal only if the newcomer already has **Docker** (plus Claude Code, git, a GitHub-authenticated `gh`, and a repo). Docker image pulls dominate the time budget. The cold run (CRQ-5.1) measures this; if >15 min, follow up on a lighter store (A-lite). Documented plainly in the quickstart.

## Tasks

| Task | Title | Depends | Layer | HITL |
|---|---|---|---|---|
| CRQ-1.1 | feat: add one-command local task store | — | CLI | |
| CRQ-1.2 | docs: replace "contact your administrator" with local-store setup | 1.1 | Shared | |
| CRQ-2.1 | fix: use the working two-step install command across the site | — | Frontend | |
| CRQ-2.2 | fix: use the working install command in brand tokens, templates and demo slides | — | Shared | |
| CRQ-2.3 | fix: update install command in .claude skill docs | — | Shared | ⚠ HITL |
| CRQ-3.1 | docs: rewrite quickstart to end at a first PR | 1.2 | Shared | |
| CRQ-3.2 | docs: rewrite README quickstart and add tagged quickstart link | 3.1, 2.1 | Shared | |
| CRQ-4.1 | ci: add clean-box quickstart job | 1.1, 2.1 | Background | |
| CRQ-5.1 | chore: human cold run on a fresh machine | 3.2, 4.1, 2.2, 2.3, 1.2 | Shared | ⚠ HITL |
| CRQ-5.2 | docs: record real demo and replace illustrative GIF | 5.1 | Shared | ⚠ HITL |

```
[START]
  ├─ CRQ-1.1 ── CRQ-1.2 ── CRQ-3.1 ── CRQ-3.2 ─┐
  │      └──────────────── CRQ-4.1 ────────────┤
  ├─ CRQ-2.1 ───────────────┴──(3.2, 4.1)      ├─ CRQ-5.1 ── CRQ-5.2
  ├─ CRQ-2.2 ──────────────────────────────────┤
  └─ CRQ-2.3 ──────────────────────────────────┘
```

All tasks: Safe to deploy standalone: yes (additive or atomic string updates).

Not carried: none; "State plainly what CI cannot cover" is in CRQ-4.1 AC.

## Decision Log

- Task persistence: defaulted to option B — store is already Postgres-only, published as an image, auto-migrates and seeds a token; A would touch 10 commands, C cannot satisfy requirement 5.
- Newcomer prerequisite: accepted Docker as a prerequisite — smallest change; gap stated in quickstart and measured by CRQ-5.1.
- Two-line install presentation: defaulted to multi-line `<pre>` with both lines copied by the copy button; INSTALL_CMD keeps a single exported string joined by newline so existing consumers stay one-symbol.
- `.claude/skills/**` install-string edits split into a HITL task (CLI hard-blocks `.claude/**` writes).
- Telemetry: UTM-tagged links only (site `withUtm` scheme); no plugin telemetry per spec.
- Cold run and demo recording: human tasks per spec; demo depends on cold run.
- #5043 already merged; README Install and plugin README are not re-edited beyond quickstart sections.

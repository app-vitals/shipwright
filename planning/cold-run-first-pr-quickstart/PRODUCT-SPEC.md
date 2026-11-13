# PRODUCT-SPEC: Cold-run first-PR quickstart

## Problem

A newcomer cannot get from the README to a first real pull request on their own repository.

- The documented install line, `/plugin install shipwright@app-vitals/shipwright`, fails on a clean Claude Code config with `Plugin "shipwright" not found in marketplace "app-vitals/shipwright"` (verified on Claude Code 2.1.323 in an empty config directory). The working form is `/plugin marketplace add app-vitals/shipwright` followed by `/plugin install shipwright@shipwright`. The README, `docs/quickstart.md`, the plugin README and TESTING are being corrected separately in PR #5043. The old line still appears in the site (`site/src/consts.ts` `INSTALL_CMD`, `site/src/content/docs/*.mdx`, `site/src/pages/index.astro`), the site Playwright specs, `brand/` tokens and templates, `demo/slides/`, and comments in `scripts/quickstart.smoke.test.ts`.
- `docs/quickstart.md` Option A ends at an offline metrics dashboard served from fixtures. Nothing in it runs `/shipwright:plan-session` or `/shipwright:dev-task`, and it produces no PR.
- `docs/quickstart.md` still says the plugin and the agent "are still being built" and that plugin install is "coming soon", which contradicts the README's proof numbers.
- Option B needs git, Bun, go-task, Docker, tmux, PostgreSQL and Claude Code plus a token before one chat turn.
- `plan-session` and `dev-task` require a running task store (`SHIPWRIGHT_TASK_STORE_URL` and a token). The task-store skill's setup text says to "contact your administrator". A newcomer with only the plugin installed has no documented way to obtain one.
- The quickstart smoke test (`QUICKSTART_SKIP_SERVE`) skips both the clone and the plugin install, so CI does not exercise the step that fails.
- The README demo GIF is captioned "(Illustrative.)".

## Goal

A person with Claude Code and a small repository of their own goes from the README to a reviewed pull request opened by Shipwright in 15 minutes or less, following only the documented steps, on a machine with no prior Shipwright or Claude Code plugin configuration. CI proves the path stays working.

## Decision the planning pass must make

Choose how the first-PR path obtains task persistence, compare the options against the codebase, and record the choice and the reasons in the Decision Log:

- **A. Plugin-only path.** A lightweight mode in which a newcomer reaches a reviewed PR with no task store, database or Docker. Best first run; the core commands currently assume the store.
- **B. One-command local store.** Keep the commands as they are and ship a single command that boots the task store and its database locally and mints a token.
- **C. Documentation and CI only.** No product change; document the existing local stack honestly.

Prefer the smallest change that meets the Goal. If the Goal cannot be met within about one week of work, choose the option that gets closest, state the gap, and say what the newcomer still has to install.

## Requirements

1. **Quickstart ends at a PR.** Rewrite `docs/quickstart.md` and the README Quickstart so the primary path ends with a reviewed PR on the reader's own repository. The fixture dashboard becomes an optional later step.
2. **Remove stale claims.** Delete or correct every "still being built" and "coming soon" statement that no longer matches the shipped product.
3. **One install command everywhere.** Replace the remaining occurrences of the failing install line across the site, site tests, brand tokens and templates, and demo slides with the working two-step form, from a single source of truth where one exists. Decide how a two-line command is presented in places designed for one line.
4. **Clean-box CI job.** Add a CI job that starts from an empty Claude Code config and covers marketplace add, plugin install, and the first-PR path as far as it can run headlessly, on every release and on changes to the quickstart, README install section or plugin manifest. State plainly in the job what it cannot cover and why.
5. **Task-store setup a newcomer can follow.** Whatever option is chosen, replace "contact your administrator" with steps a newcomer can complete alone.
6. **Countable installs.** Add a tagged quickstart link (UTM or equivalent) so visits that reach the install step can be measured. Do not add telemetry to the plugin without a separate decision.
7. **Human cold run before any recording.** A person runs the finished path on a fresh machine or container with no existing configuration and logs every failure. This is a human-in-the-loop task and gates the demo.
8. **Real demo.** Replace the "(Illustrative.)" GIF with a recording of the clean pass. Recording is a human task that depends on requirement 7.

## Out of scope

- Hardening the self-hosted agent image, version-pin drift and the reconcile job.
- Paid acquisition and video distribution.
- Kubernetes and cloud deployment documentation.

## Testing strategy

- Content tests for the README and quickstart assert the working install form and the absence of the failing one.
- The clean-box CI job is the smoke layer for the install path.
- Site Playwright specs are updated alongside the `INSTALL_CMD` change.

## Source map

- `README.md`, `docs/quickstart.md`, `docs/README.md`
- `scripts/quickstart.sh`, `scripts/quickstart.smoke.test.ts`
- `plugins/shipwright/README.md`, `plugins/shipwright/skills/task-store/SKILL.md`, `.claude-plugin/marketplace.json`
- `site/src/consts.ts`, `site/src/content/docs/getting-started.mdx`, `site/src/content/docs/running-locally.mdx`, `site/tests/*.spec.ts`
- `brand/tokens.json`, `brand/BRAND.md`, `brand/templates/`, `demo/slides/`
- `task-store/`, `Taskfile.yml`


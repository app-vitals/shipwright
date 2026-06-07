# Contributing to Shipwright

Thanks for your interest in contributing. Shipwright is an MIT-licensed project destined to be public — keep all contributions free of proprietary or confidential material (see the scrub rules in [CLAUDE.md](./CLAUDE.md)).

## Coding conventions

Follow the conventions in [CLAUDE.md](./CLAUDE.md). The short version:

- **Tests land with the code** — same PR, correct layer (unit / integration / smoke / e2e). No "add tests later" tasks.
- **Test isolation** — no `mock.module()`, no `global.fetch` / `global.*` overrides.
- **Plugin stays repo-agnostic** — no new coupling to any external platform.
- Lint, typecheck, and tests must pass locally before opening a PR:
  ```
  bunx biome lint .
  bun run --filter='*' typecheck
  bun test
  ```

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add deploy rollback command
fix: handle missing task status label
docs: update CLAUDE.md conventions
chore: bump biome to 1.9
```

The type prefix drives `release-please` — it decides what goes in the changelog and whether to bump patch / minor / major. Keep messages accurate.

## Release flow

Releases are fully automated via `release-please`:

- **Never hand-edit `CHANGELOG.md` or version fields** (`package.json`, etc.). `release-please` owns those files and will overwrite manual edits.
- When enough merged commits accumulate, `release-please` opens an auto-generated release PR that bumps the version and updates the changelog.
- A maintainer reviews and merges that PR — squash-merge is recommended to keep the release commit clean.
- Merging the release PR triggers the publish workflow (tag + GitHub Release).

In short: land your feature PRs with good Conventional Commit messages, and the release machinery takes care of itself.

## Pull requests

- Branch from `main`; follow the naming convention in CLAUDE.md (`feat/sw-x-y-slug`).
- Keep PRs focused — one task, one PR.
- The CI gate (lint → typecheck → test → secret scan) is merge-blocking. All checks must be green.

## Still to come

`CODE_OF_CONDUCT.md` and issue / PR templates are deferred to public launch.

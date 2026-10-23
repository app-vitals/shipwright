# Contributing

Thanks for your interest. This document covers the conventions and the release process.

## Code of conduct

Be respectful and constructive.

## Conventions

### Commit style and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Allowed types: `feat`, `fix`, `perf`, `revert`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. Mark breaking changes with `!` after the type or a `BREAKING CHANGE:` footer.

Pull requests are squash-merged, so the PR title becomes the commit subject that semantic-release reads. The `pr-title-lint` workflow rejects titles that are not Conventional Commits.

### Tests land with the code

Tests ship in the same PR as the change, at the right layer:

- **unit** (`*.unit.test.ts`): pure logic, no I/O
- **integration** (`*.integration.test.ts`): real dependency behavior through injected doubles or a test database
- **smoke** (`*.smoke.test.ts`): endpoints exercised in-process, or image-level checks in CI
- **e2e** (`admin/e2e/`): browser flows through Playwright

### The import boundary

Everything in `runtime/`, `admin/`, `lib/` and `agent-types/` must resolve inside this repository. `bun run check:boundary` fails on any import that leaves it.

## Development workflow

1. Branch from `main`; never commit to `main` directly.
2. Run `bun run lint`, `bun run typecheck`, `bun run check:boundary` and `bun test` before pushing.
3. Open a PR with a Conventional Commit title.

## Release process

Releases are on demand and driven by semantic-release through the `Release` workflow.

1. Go to **Actions, Release** and click **Run workflow**.
2. Run with `dry_run` set to `true` first to preview the version and changelog.
3. Re-run with `dry_run` unchecked to publish.

Do not edit `CHANGELOG.md` by hand; semantic-release owns it.

# Contributing to Shipwright

Thanks for your interest. This document covers the conventions, workflow, and release process for contributors.

## Code of conduct

Be respectful and constructive. This project follows our [Code of Conduct](./CODE_OF_CONDUCT.md) — by participating, you agree to uphold it.

## Conventions

### Commit style — Conventional Commits

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.

Breaking changes: append `!` after the type/scope or add a `BREAKING CHANGE:` footer.

### Tests land with the code

Tests are required in the same PR as the feature or fix — no "add tests later" tasks. Land the code and its tests together, at the correct layer:

- **unit** — pure logic, no I/O.
- **integration** — real dependency behavior via recorded fixtures / injected doubles.
- **smoke** — HTTP endpoints exercised in-process (no real socket).
- **e2e** — full browser flows via Playwright.

See [`CLAUDE.md`](./CLAUDE.md) for the full conventions, test isolation rules, and layer boundaries.

### Code conventions

Follow the guidance in [`CLAUDE.md`](./CLAUDE.md): no new platform coupling, local-first by default, MIT license across all artifacts.

## Development workflow

1. Find a `status:pending` issue with all dependencies marked `status:done`.
2. Branch from the `branch` field in the issue's YAML block (pattern: `feat/sw-x-y-slug`). Never work directly on `main`.
3. Build, test, and open a PR — all in one go.
4. Request review; address findings via follow-up commits on the same branch.

## Release process

Releases are managed by **release-please**. The bot watches `main` and opens a release PR whenever there are releasable commits. That PR auto-updates `CHANGELOG.md` and version fields based on the commit history.

**Never hand-edit `CHANGELOG.md` or any version field.** Let release-please own those files — manual edits will be overwritten or will break the automation.

When the release PR is ready:
- A maintainer reviews and merges it.
- **Squash-merge is recommended** to keep the release commit clean.
- Merging the release PR triggers the publish workflow and creates the GitHub release tag.

## Submitting a pull request

- Keep PRs focused — one concern per PR.
- Squash noisy fixup commits before asking for review.
- Confirm CI is green before requesting a review.
- This repository is destined to be public and MIT-licensed — do not include proprietary or confidential material.

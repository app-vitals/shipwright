---
name: repo-config
description: >
  Cross-cutting contract for the test-readiness pipeline. Specifies the GitHub repository configuration that makes "tests pass" structurally meaningful instead of advisory — branch protection requiring CI to pass, required secrets, environments, deploy hooks, and PR templates. Referenced by `test-design` (Phase 2 emits the repo-config plan) and `test-roadmap` (Phase 4 auto-pairs workflow tasks with branch-protection tasks). Without these, the verification commands in each task body are honor-system; with them, the workflow is the gate.
---

# repo-config skill

## Purpose

Capture the repository-level configuration that turns CI into an actual gate. The audit's verification commands are only meaningful if `main` cannot be merged unless they pass.

## When invoked

- By `test-design` (Phase 2) — emits the **Repo Configuration** section of the blueprint
- By `test-roadmap` (Phase 4) — applies the **pairing rule** (every CI-workflow task gets a paired branch-protection task)
- By `test-publish` (Phase 5) — emits the **Closing Checklist** at the end of every task issue body

## The repo-config plan

A complete repo-config plan covers four concerns:

### 1. Branch protection

For each protected branch (default: `main`):

- **Required PR** — no direct pushes
- **Required status checks** — every layer-relevant CI job from `test.yml` (lint, per-service unit, per-service integration, smoke, E2E)
- **Require branches to be up to date before merging** — yes
- **Require conversation resolution before merging** — yes
- **Required approving reviews** — ≥1 (≥2 for repos with multiple maintainers)
- **Enforce on admins** — yes (recommended; document break-glass procedure if not)
- **Canary status check is NOT included** — canary runs post-merge; gates promotion staging → prod, not merge to main

### 2. Required secrets and environments

For each external integration named in the inventory, list the GitHub secret needed to authenticate against it in CI and canary mode. For each deployment target, list the GitHub Environment.

Minimum set for the test pipeline:
- `TEST_CANARY_API_KEY` — scoped canary auth token
- `TEST_TARGET_URL` per environment (often set in the workflow, not as a secret)
- Per-external: `<SERVICE>_API_KEY` (used only if recording new fixtures)
- Per-environment GitHub Environments (`staging`, `production`) with required reviewers if promotion is gated

### 3. Deploy hooks

- Post-deploy workflow trigger — typically `workflow_run` on the deploy workflow's `completed` event filtered to success
- Canary workflow uses the deployed env's `TEST_TARGET_URL`
- Promotion workflow gated on canary success

See [`references/deploy-canary-promote.md`](./references/deploy-canary-promote.md) for a full reference contract covering the three critical wiring details: non-empty-tag guard, skipped-job-counts-as-success hole, and staging-vs-prod `TEST_TARGET_URL`.

### 4. PR conventions

- **Closing PR must reference the issue** via `Closes #N` or `Fixes #N` in the body
- **Verification output** — the PR description must include the output of the issue's `Verification command` (or a CI run link that shows the same)
- **Acceptance-criteria checkboxes** — all checked before merge

A PR template (`.github/pull_request_template.md`) can enforce the verification-output convention via a checklist.

### 5. Recorded-fixture maintenance loop (deferred)

Recorded fixture doubles (msw handlers, nock recordings, hand-authored JSON) capture the shape of third-party API responses at a point in time. Without scheduled re-recording, recorded fixtures go stale silently — the test suite stays green while the live integration is broken. A maintenance loop catches this before production does.

**Status: deferred — not implemented.** The auto-recording GitHub Actions pattern below is a target design, not built tooling. Do not wire it up until the manual, hand-authored-fixture workflow is running and tuned.

See the [full recorded-fixture maintenance loop pattern](#recorded-fixture-maintenance-loop-deferred) below for implementation details (deferred).

## The pairing rule (Phase 4 — test-roadmap)

When generating the task list, every task that creates or modifies a CI workflow file (e.g., `.github/workflows/test.yml`) MUST be paired with a task that enables the corresponding branch-protection requirement.

Pattern:

| Workflow task | Paired branch-protection task |
|---|---|
| Create / update `test.yml` with required jobs | Enable branch protection on `main` requiring those jobs |
| Add canary workflow | Wire as deploy-gate (NOT as merge-gate) |
| Add deploy workflow | Add `staging` / `production` GitHub Environments with required reviewers |

The branch-protection task `depends_on` the workflow task. Land workflow first; verify green on main for a few days; then enable protection. Sequencing is in this order to avoid the chicken-and-egg block.

## The closing checklist (Phase 5 — test-publish)

Every published task issue must include a **Closing Checklist** at the end of its body. This converts the verification command from a suggestion into a mergeable gate:

```markdown
## Closing checklist

Before closing this issue (or merging the PR that closes it):

- [ ] All acceptance-criteria checkboxes above are ticked
- [ ] `Verification command` run; output pasted in the closing PR description
- [ ] CI is green on the PR (assuming T-042 / branch protection is enabled)
- [ ] No source files outside `Files to touch` were modified, or the deviation is justified in the PR description
```

The third item only becomes a hard gate once branch protection is on. Until then, it's still good hygiene.

## What this skill produces in artifacts

### In `test-system.md` (Phase 2 output)

A `## Repo configuration` section with the four concerns filled in for the target repo:
- Branch protection rule definition
- Required secrets list
- Required environments list
- PR template recommendation

### In `test-readiness-plan.md` (Phase 4 output)

A `## Repo configuration tasks` block listed alongside the test tasks. By default these go in **M1** (infrastructure baseline) with `depends_on` pointing at the corresponding workflow task.

### In each task issue body (Phase 5 output)

A `## Closing checklist` section at the bottom.

## Recorded-fixture maintenance loop (deferred)

> **Deferred — not implemented.** This section documents the target auto-recording design (a scheduled GitHub Actions workflow). None of this tooling — the workflow, the environment, the re-record scripting — has been built yet. Defer implementation until the manual, hand-authored-fixture workflow is running and tuned.

Recorded fixture doubles (msw handlers, nock recordings, hand-authored JSON) capture the shape of third-party API responses at a point in time. Without scheduled re-recording, recorded fixtures go stale silently — the test suite passes while the integration is broken in production. A recorded-fixture maintenance loop catches drift weekly before it becomes a production incident.

### Where the cron lives

A dedicated GitHub Actions workflow `.github/workflows/recorded-fixture-refresh.yml` (not yet created) on a weekly schedule (e.g., `cron: '0 9 * * 1'` — Mondays at 09:00 UTC). The job:

1. Checks out the repo
2. Runs re-record mode for each service that has recorded fixtures (typically `RECORD_MODE=all bun test` or the msw/nock equivalent)
3. Checks `git diff` for any changed fixture files
4. If diff is non-empty: opens a PR titled `chore: refresh recorded fixtures (auto)` via `gh pr create`, with a `git diff --stat` summary and one expanded hunk in the body
5. If diff is empty: exits 0 silently

### What triggers re-recording

| Trigger | When to use |
|---|---|
| Scheduled cron | Weekly (always) |
| Manual `workflow_dispatch` | When a third-party publishes a breaking-change notice |
| Feature-branch CI | Never — recorded fixtures are not re-recorded on PRs (avoids network flake) |

The re-record job authenticates against the real third-party APIs using credentials stored in a dedicated `recorded-fixture-refresh` GitHub Environment. This environment has narrower permissions than `production` and is not shared with integration test runs.

### How diff alerts are surfaced

| Scenario | Outcome |
|---|---|
| No diff | Silent pass — no PR, no noise |
| Diff detected | PR opened, tagged `recorded-fixture-refresh`, body includes diff stat + one expanded hunk |
| API call fails during re-record | Workflow fails; GitHub sends default failure notification to repo watchers |
| Open refresh PR already exists | Skip creation — check for existing open PR with same title before calling `gh pr create` |

**Do not auto-merge.** The diff is a signal, not a safe auto-apply. A human must verify whether the response shape change is a breaking change, a non-breaking evolution, or a transient fluke before merging.

### Repo-config additions

Include in the **Required secrets and environments** section of the `test-system.md` artifact:

- **GitHub Environment:** `recorded-fixture-refresh` — no required reviewers (cron runs unattended), restricted to the `recorded-fixture-refresh.yml` workflow
- **Secrets in this environment:** one per external integration (`STRIPE_TEST_API_KEY`, `SENDGRID_API_KEY`, etc.)
- The `recorded-fixture-refresh` workflow runs on `main` and submits PRs — it is safe to enable before branch protection is configured

Include in the **test-readiness-plan.md** task list (M1):

- One task per external HTTP dependency that has recorded fixtures: "Wire recorded-fixture-refresh cron for `<service>`"
- One task: "Add `recorded-fixture-refresh` GitHub Environment + secrets"

These tasks depend on the same-layer "record fixtures for `<service>`" task, not on branch protection.

## Anti-patterns

- **"Tests pass" without branch protection.** Without enforcement, the audit is a social contract. Engineers WILL bypass it under deadline pressure. Branch protection is the only mechanism that scales beyond one careful reviewer.
- **Required canary checks at merge time.** Canary needs a deployed env; gating merge on canary creates a deadlock. Canary gates *promotion*, not merge.
- **Admin exemption without a break-glass policy.** Exempting admins is fine if there's a documented "in case of fire" procedure; otherwise it's an unmonitored backdoor.
- **Secrets baked into workflows.** Use GitHub Secrets + Environments. Workflow YAML references `${{ secrets.X }}`, never literal values.
- **No PR template.** Closing checklists in issue bodies help, but PRs without a template forget the verification-output convention within weeks.
- **Committing recorded-fixture diffs directly to main.** The refresh job must always open a PR, never push directly — the diff must be reviewed.
- **Re-recording on every CI run.** Network calls in CI create flake, inflate build times, and burn third-party rate limits. Re-record on schedule only.
- **Sharing recorded-fixture-refresh credentials with CI integration tests.** Integration tests should use read-only scoped tokens. Re-record credentials are broader — keep them scoped to the `recorded-fixture-refresh` environment.

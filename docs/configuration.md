# Configuration

> Single authoritative reference for all Shipwright configuration options, organized by scope: [Plugin Config](#plugin-config), [Agent Config](#agent-config), and [Policy Config](#policy-config).

## Precedence

When the same option can be set multiple ways, resolution order is:

```
env var  >  built-in default
```

**Env vars are the only configuration path.** All Shipwright configuration is supplied via env vars — injected by the admin service for managed agents, or set in the local environment for direct plugin use.

---

## Plugin Config

Configuration for the Shipwright Claude Code plugin (`plugins/shipwright/`). These options control workspace discovery, task-store backend, and GitHub CLI integration.

### Env vars

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_REPOS_DIR` | `string` | `<workspace>/repos` | Fallback repos directory for plugin scripts when workspace discovery finds no `repos/` dir. |
| `SHIPWRIGHT_REPO_DIR` | `string` | `$HOME/src` | Where the plugin commands (`dev-task`, `patch`, `deploy`, `plan-session`) look for repo clones. The provisioner injects `<AGENT_HOME>/workspace/repos` for managed agents so clones live on the PVC. |
| `SHIPWRIGHT_WORKTREE_DIR` | `string` | `$HOME/worktrees` | Where the plugin commands create git worktrees. The provisioner injects `<AGENT_HOME>/workspace/worktrees` for managed agents — `$HOME` is ephemeral overlay storage in the agent container, and worktrees there can trigger pod eviction. |
| `SHIPWRIGHT_ADMIN_API_KEY` | `string` | — | Bearer token `task agent-workspace-pull -- <id-or-name>` (`scripts/agent-workspace-pull.ts`) presents to the admin service to resolve the target agent via `GET /agents` and fetch its config bundle; must match an entry in the server's `SHIPWRIGHT_ADMIN_API_KEYS`. Used alongside `SHIPWRIGHT_API_URL` (see [Shipwright platform](#shipwright-platform)), set here by the operator's own shell rather than injected by the provisioner. Env-var-only (secret). |
| `SHIPWRIGHT_WORKSPACE_PULL_ROOT` | `string` | `~/.shipwright-agents` | Root directory `task agent-workspace-pull -- <id-or-name>` scaffolds the mirrored workspace under, keyed by the resolved agent's name: `<root>/<name>`. |
| `GH_CMD` | `string` | `gh` | Override the `gh` CLI executable. Useful in environments where `gh` is installed to a non-default path. |
| `AGENT_HOME` | `string` | `/data/agent-home` | Persistent storage root for workspace files, mise caches, and `~/.claude`. Set in the agent container; also used by plugin scripts for workspace discovery. |
| `WORKSPACE_PATH` | `string` | — | Direct workspace path override. Takes precedence over `AGENT_HOME`-based discovery when set. |
| `SHIPWRIGHT_TASK_STORE_URL` | `string` | — | Base URL of the Shipwright task-store HTTP service — the only task-store backend. Required (alongside `SHIPWRIGHT_TASK_STORE_TOKEN`) for `dev-task`, `review`, `patch`, `deploy`, and the `task-store` skill to function. |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | `string` | — | Bearer token for task-store API access. See the [Metrics & Admin & Chat & Task-Store services](./configuration-agent.md#metrics--admin--chat--task-store-services) table below for how it's minted and injected for managed agents. Env-var-only (secret). |
| `SENTRY_ORG` | `string` | — | Sentry organization slug (e.g., `acme-corp`). Required (alongside `SENTRY_AUTH_TOKEN`) for the `error-scan` and `error-resolve` skills to query the Sentry Issues API. When unset, the error-scan and error-resolve skills exit early with a skipped status. Env-var-only (secret — exposes the org name). |
| `SENTRY_AUTH_TOKEN` | `string` | — | Sentry API token for authentication. Required (alongside `SENTRY_ORG`) for the `error-scan` and `error-resolve` skills to access Sentry project data and issues. Must have permissions to query projects and issues (and mutate issue state for error-resolve) in the target org. Env-var-only (secret). |

---

## Agent Config

Configuration for the Shipwright agent runtime (`agent/` and `admin/`) — moved to
[`docs/configuration-agent.md`](./configuration-agent.md) to keep this file under the
docs-freshness line-count threshold.

---

## Observability

Each of `admin`, `metrics`, `task-store`, and `agent` reads its own `SENTRY_DSN` from its own environment — there is no shared/global toggle. See [`docs/observability.md`](./observability.md) for exactly what is (and isn't) collected and how the scrub hooks work.

`SENTRY_DSN` / `SENTRY_ENVIRONMENT` are documented per-service rather than repeated here: see the `SENTRY_DSN` row under [Agent Config → Server](./configuration-agent.md#server) for the agent — including the pod-startup timing constraint, since `initSentry` runs once at module load, before the config sync loop — and the `SENTRY_DSN` row under [Agent Config → Metrics & Admin & Chat & Task-Store services](./configuration-agent.md#metrics--admin--chat--task-store-services) for `task-store`, `metrics`, and `admin`.

This is the write side (services reporting into Sentry). For the read side — the `SENTRY_ORG` / `SENTRY_AUTH_TOKEN` credentials (documented above under [Plugin Config](#plugin-config)) and how the `error-scan`, `error-fix`, and `error-resolve` skills query the Sentry Issues API — see [Read side](./observability.md#read-side) in `docs/observability.md`.

---

## Policy Config

Agent behavior is controlled by `state/agent-policy.md`. This is a Markdown file with a YAML front-matter block, automatically seeded from a template when the workspace is provisioned. Edit it directly to change review posting, merge permissions, and autonomy levels without reconfiguring crons or restarting the agent. `auto_post_reviews` defaults to `true` (reviews post to GitHub automatically) on initial provisioning; set it to `false` to stage reviews locally for owner approval instead.

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `auto_post_reviews` | `bool` | `true` | Post review comments to GitHub automatically without manual approval. Set to `false` to stage reviews locally for owner approval instead. |
| `allowed_events` | `string[]` | `["COMMENT", "APPROVE"]` | GitHub review event types the agent may emit. |
| `review_external_prs` | `bool` | `true` | Currently unused — `/shipwright:review` always targets a single explicit PR (no repo-wide scan to filter), and no other command reads this field. |
| `allow_self_review` | `bool` | `false` | Read by `agent/src/check-review.ts`'s `getReviewCandidates()` (the `shipwright-loop` cron's in-process review candidate provider) to decide whether the agent's own open PRs are review candidates. Self-review is excluded by default — the agent's own open PRs require a human reviewer. Set to `true` to opt in and let the agent review its own PRs. (Technical note: `false` is also the internal code-level fallback used if `state/agent-policy.md` is ever missing or unparseable — in normal operation the template-seeded `false` above is what's in effect either way, since every provisioned agent gets the policy file seeded on startup.) **Exception (RRR-1.1, extended to the allowlist by RRA-1.1):** when the agent is explicitly listed as a requested reviewer on a PR (via GitHub's "Request a reviewer" UI), the PR is included even if `allow_self_review=false` — an additive override allowing human-directed self-review — **and** even if the PR's author is excluded from the author allowlist (the `Agent.reviewAuthorAllowlist` DB field, synced via `reviewAuthorAllowlistRef`; local-dev equivalent `SHIPWRIGHT_HITL_AUTHORS`). For an already-allowlisted author this bypass has no observable effect, since `isAuthorAllowed` already includes them unconditionally; its only meaningful effect is widening eligibility for non-allowlisted authors. This is a known, accepted access-boundary loosening (confirmed with the team), not an oversight: any collaborator with repo write access can trigger an agent review by explicitly requesting one, which bypasses the allowlist for that PR. All other filters (draft status, automated-label, live-review dedup, task-store dedup, HITL/blocked, bundle-incomplete) remain unconditionally applied regardless of requested-reviewer status. Bot-authored PRs (Dependabot, Renovate) are no longer unconditionally excluded here either — DBR-3.3 removed that pre-filter, so they now fall through to the `isAuthorAllowed` gate like any other author. |
| `min_confidence` | `number` | `75` | Minimum confidence score (0–100) for a finding to be included in a review. |
| `max_findings` | `number` | `5` | Maximum number of findings to include in a single review. |
| `cleanup_merged_worktrees` | `bool` | `true` | Read by the agent's background worktree reconciler to decide whether merged-PR worktrees are automatically removed (`agent/src/pr-state-reconciler.ts`'s `reconcileRecord()`). Not read by `/shipwright:review`. |
| `cleanup_after_days` | `number` | `14` | Age threshold (days) before a worktree is eligible for automatic cleanup via `reconcileStaleWorktrees()` (`agent/src/worktree-reaper.ts`, run on the same background interval as `agent/src/pr-state-reconciler.ts`). Not read by `/shipwright:review`. |

### Example

```markdown
---
auto_post_reviews: true
allowed_events: [COMMENT, APPROVE]
allow_self_review: false
min_confidence: 75
max_findings: 5
cleanup_merged_worktrees: true
cleanup_after_days: 14
---
```

(`review_external_prs` is omitted above — see the table row: currently unused.)

---

## See also

- [architecture.md](./architecture.md) — the four-artifact A→B→C→D design.
- [agent.md](./agent.md) — Shipwright agent runtime, admin CRUD APIs, and data model.
- [quickstart.md](./quickstart.md) — how to get the full dev stack running locally.
- `CLAUDE.md` — env var namespacing convention and database env var rules.

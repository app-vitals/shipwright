---
name: ship-loop
description: >-
  This skill MUST activate when the user wants to autonomously drain the Shipwright task
  queue in a loop — e.g. "run the ship loop", "start the autopilot", "drain the task queue",
  "keep shipping ready tasks", "dev-task then review-patch then deploy until done", or when
  invoking it under `/loop`. It performs ONE pipeline step per call —
  /shipwright:dev-task → /shipwright:review-patch → /shipwright:deploy for the next ready
  task — and is designed to be wrapped by `/loop` for continuous, self-paced operation until
  the milestone queue is empty. Also triggers on edits or questions about this repo's
  autonomous delivery loop.
---

# Ship Loop

Autonomous delivery loop for **this repo's** Shipwright pipeline. One invocation = **one
pipeline step**. Wrap it with `/loop` to run continuously and self-paced until the queue is
drained.

**Default mode:** drain the queue and **auto-deploy** — ship the next ready task, drive its
PR to CI-green + reviewed, then merge/deploy it, and repeat. Fully autonomous; no human gate.

> ⚠️ This runs autonomously and is **outward-facing**: it opens PRs, pushes fixes, posts
> reviews, and **merges/deploys** on a repo bound to go public — without pausing for input.
> Start it only when you intend that. Interrupt (Esc) to stop.

## How to run

- **Continuous (recommended):** `/loop run the ship-loop skill` — omitting an interval makes
  `/loop` self-pace (it waits while CI runs, then resumes). Equivalent shorthand: `/loop ship-loop`.
- **Fixed cadence:** `/loop 10m run the ship-loop skill` — re-fire every 10 minutes instead.
- **Single step:** invoke `ship-loop` directly to run exactly one iteration.
- **Stops itself** once the queue drains — after 3 consecutive idle ticks with no deploy, review,
  patch, or ready-task work (it backs off 10→20→30 min between idle checks first).

## Prerequisites (one-time, per machine)

This repo lives at a non-standard path, so Shipwright's `~/src/{repo}` defaults don't apply, and
the cron prechecks need a workspace path. Set these five vars in `.claude/settings.local.json`
(git-ignored) using **absolute paths for your machine**, then **restart the session** (env loads
at startup):

```json
{
  "env": {
    "SHIPWRIGHT_CONFIG": "<ABSOLUTE_PATH_TO_THIS_REPO>/.shipwright.json",
    "SHIPWRIGHT_REPO_DIR": "<ABSOLUTE_PATH_TO_THE_PARENT_DIR_OF_THIS_REPO>",
    "SHIPWRIGHT_REPOS_DIR": "<ABSOLUTE_PATH_TO_A_DIR_CONTAINING_ONLY_THIS_REPO_CLONE>",
    "SHIPWRIGHT_WORKTREE_DIR": "<ABSOLUTE_PATH_TO_A_WORKTREES_DIR>",
    "WORKSPACE_PATH": "<ABSOLUTE_PATH_TO_THIS_REPO>"
  }
}
```

- `SHIPWRIGHT_CONFIG` selects the **GitHub Issues** task store. Unset ⇒ silent fallback to a
  local JSON store ⇒ no issues are read. There is **no auto-discovery**.
- `SHIPWRIGHT_REPO_DIR` is the **parent** of this repo, so `/shipwright:dev-task` resolves
  `$SHIPWRIGHT_REPO_DIR/<repo>` instead of the missing `~/src/<repo>` (its worktree step fails
  without this).
- `SHIPWRIGHT_REPOS_DIR` is how the **PR gates** (`check-deploy` / `check-review` / `check-patch`)
  discover which repo to query. They do **not** read `.shipwright.json` — `resolveRepos()` scans
  `<WORKSPACE_PATH>/repos/` then `$SHIPWRIGHT_REPOS_DIR` for git clones and parses each
  `.git/config` origin URL. **Unset ⇒ it returns `[]` and the gates silently fall back to the
  hardcoded `app-vitals/vitals-os`** — i.e. they query the wrong repo and never see your PRs
  (DEPLOY and review-patch go permanently idle while real PRs sit open). Point this at a directory
  that contains **only one clone (or a symlink) of this repo** — the gates use `repos[0]`, so a
  multi-repo parent dir resolves an arbitrary sibling. Example:
  `mkdir -p ~/.shipwright-repos && ln -sfn <ABSOLUTE_PATH_TO_THIS_REPO> ~/.shipwright-repos/shipwright`,
  then set `SHIPWRIGHT_REPOS_DIR` to `~/.shipwright-repos`. (Note: this is **not** the same as
  `SHIPWRIGHT_REPO_DIR` (singular) above — different consumer, different value.)
- `SHIPWRIGHT_WORKTREE_DIR` is where worktrees are created.
- `WORKSPACE_PATH` is where the prechecks read/write agent state (`state/reviews.json` for review
  dedup, optional `agent-policy.md`). The repo root works — `state/` is git-ignored. Without it,
  `check-review-patch` / `check-deploy` throw `AGENT_HOME is not set`.

**Verify before looping:**
```bash
echo "$SHIPWRIGHT_CONFIG"; echo "$WORKSPACE_PATH"; ls -d "$SHIPWRIGHT_REPO_DIR"/* >/dev/null && echo "repo dir ok"
# Gate repo resolution: SHIPWRIGHT_REPOS_DIR must contain a clone whose origin matches .shipwright.json.
# If this prints nothing, the gates will silently query app-vitals/vitals-os instead of your repo.
for d in "$SHIPWRIGHT_REPOS_DIR"/*/.git/config; do grep -h 'url = ' "$d" 2>/dev/null; done
D=$(find ~/.claude/plugins/cache -maxdepth 5 -name task_store.ts -path '*/shipwright/*' | head -1 | xargs dirname)
bun "$D/task_store.ts" doctor                          # must report the github backend
bun "$D/check-review-patch.ts" >/dev/null 2>&1; echo "review-patch gate exit=$?"   # 0/1 = ok; 2 = WORKSPACE_PATH unset
```

## Procedure — one tick (cheap-gated, backoff-aware)

Each tick reuses the plugin's compiled prechecks as a **token-free gate** — exit codes only, no
model reasoning over `gh` output — and only spends tokens (spawns a `/shipwright:*` command) when
a precheck signals real work.

**Resolve the plugin scripts dir once** (all prechecks live here):
```bash
PLUGIN=$(find ~/.claude/plugins/cache -maxdepth 5 -name task_store.ts -path '*/shipwright/*' | head -1 | xargs dirname)
```

**Preflight (first tick only):** `bun "$PLUGIN/task_store.ts" doctor` → must report the github
backend, else **STOP** (`SHIPWRIGHT_CONFIG` unset — see Prerequisites).

**1. Cheap gates** — capture only an exit code / count; no `gh` parsing or state inspection by the
model (the scripts do that and return a signal). The two `check-*` scripts need `WORKSPACE_PATH`
set (see Prerequisites):
```bash
bun "$PLUGIN/check-deploy.ts"       >/dev/null 2>&1; DEPLOY=$?   # 0 = a PR is green+approved → ready to merge/deploy
bun "$PLUGIN/check-review-patch.ts" >/dev/null 2>&1; RP=$?       # 0 = a PR needs review OR patch (combined gate)
READY=$(bun "$PLUGIN/task_store.ts" query --ready 2>/dev/null | jq 'length')   # ready-task count
```
Work signals: `DEPLOY == 0`, `RP == 0`, `READY > 0`.

> Use `task_store.ts query --ready` for the task gate — **not** `check-dev-task.ts`, which has a
> broken `lib/clock.ts` import in the published plugin cache. Note `check-deploy.ts` also
> **reconciles** any already-merged PRs to `merged` as a side effect (benign board-sync, but not a
> pure read).

**2. Act on the highest-priority signal — exactly ONE action per tick** (finish/advance before
starting new work, to keep WIP low):
- `DEPLOY == 0` → `/shipwright:deploy`        — ship the ready PR.
- else `RP == 0` → `/shipwright:review-patch` — drive the open PR's review ↔ patch to green
  (it self-caps at a 25-minute budget; this loop re-invokes it next tick).
- else `READY > 0` → `/shipwright:dev-task`   — build + open the next ready task's PR.

**3. Intelligent backoff (the idle timeout).** Track an empty-streak across ticks in a tiny state
file so it survives re-fires:
```bash
S=$(cat /tmp/ship-loop.streak 2>/dev/null || echo 0)
```
- **Work taken** (any action ran) → `echo 0 > /tmp/ship-loop.streak`; schedule the next tick in
  **~270s** (stays inside the prompt-cache window while CI runs).
- **No work** (`DEPLOY` and `RP` both `1`, and `READY == 0`) → `echo $((S+1)) > /tmp/ship-loop.streak`; before
  re-checking, wait with exponential backoff — **10 min → 20 min → 30 min**
  (`[600,1200,1800][min(S,2)]` seconds). After **3 consecutive empty ticks** → **STOP** and report
  the queue drained.

Under `/loop` self-paced mode this just means: pick the `ScheduleWakeup` delay from the rule above,
and omit it (end the loop) when the empty-streak reaches 3. Reset `/tmp/ship-loop.streak` when you
start a fresh run.

## Knobs (change the default behavior)

| Goal | Change |
|---|---|
| **Drain + deploy** (default) | All three gates active; priority deploy → review-patch → dev-task. |
| **Stop at green** (don't merge/deploy) | Drop the `check-deploy.ts` gate + the deploy action; a PR is done once `check-review-patch.ts` reports nothing left (CI green + findings resolved). |
| **Require a human Approve** | Before the deploy action, additionally require `gh pr view <n> --json reviewDecision` == `APPROVED` (not just Shipwright's self-review). The loop keeps CI green / findings addressed while waiting for the human. |
| **Single PR only** (no new tasks) | Drop the `task_store.ts query --ready` gate + the dev-task action; only deploy / review-patch the current open PR. |
| **Idle forever (watcher)** | Cap the idle backoff at 30 min and never honor the 3-empty STOP — keep polling for new work indefinitely. |

## Gotchas

- **`allow_self_review` defaults to `true`** (read from `agent-policy.md`; absent ⇒ true), so
  `/shipwright:review` reviews and approves your **own** PRs — which is what makes auto-deploy
  work unattended. If a policy sets it `false`, the review/deploy steps won't proceed on your own
  PRs without a second reviewer.
- **`deploy` drives a Deploy → Canary → Promote pipeline.** This repo has no canary/promote
  target configured yet, so `/shipwright:deploy` here is effectively **auto-merge** (and may
  surface a canary-stage notice). Verify the first run; if you only want a merge, that's fine —
  otherwise use the **Stop at green** knob and merge manually.
- **`review-patch` operates on *all* your open PRs**, not just the latest — fine with one PR in
  flight, surprising with several.
- **Checks-API token nuance:** `gh pr view --json statusCheckRollup` / `gh pr checks` work with a
  normal OAuth token; an agent PAT without Checks access must use the Actions API
  (`gh api repos/<owner>/<repo>/actions/runs?branch=<branch>` filtered by head SHA).
- **`check-patch.ts` CI-failure detection is broken in the published plugin cache** (≤4.26.0): it
  calls `gh pr checks --json conclusion`, but `conclusion` is not a valid `gh pr checks` field, so
  the query throws and the swallowing try/catch returns `hasFailing:false`. Net effect: a PR whose
  *only* problem is failing CI **and** that has already been reviewed at HEAD (so the review gate
  skips it too) will leave `review-patch` idle — the loop won't auto-patch it. Until the upstream
  plugin is fixed, drive such a PR with `/shipwright:patch` directly, or push the CI fix by hand.
  (The `/shipwright:patch` *command* uses the Actions API correctly — only the precheck gate is blind.)
- **Gates are token-free, not API-free:** `check-deploy.ts` / `check-review-patch.ts` and the
  `task_store.ts query --ready` count make `gh`/GraphQL calls and read the task store, so they
  need `SHIPWRIGHT_CONFIG` + `WORKSPACE_PATH` set and `gh` authenticated (all covered by
  Prerequisites). They cost no model tokens — that's the point — but they do count against GitHub
  API rate limits, so the idle
  backoff also keeps API usage sane.
- **Idempotent & resumable:** every step discovers its own state from GitHub, so a re-fired
  tick safely resumes (`dev-task` picks the next ready / resumes an in-progress task; the
  prechecks recompute from scratch each tick).

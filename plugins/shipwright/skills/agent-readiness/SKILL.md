---
name: agent-readiness
description: "Score one repo against the agent-readiness catalogue (docs/readiness.md) with the deterministic scorer, post one ReadinessSnapshot and record one run. Requires --repo org/repo. No model judgment, no task creation, no repo files."
argument-hint: "--repo org/repo"
---

# Agent Readiness

Score **one repo** against the agent-readiness catalogue ([docs/readiness.md](../../../../docs/readiness.md)):
run every detector, compute the level, post one `ReadinessSnapshot` and record one `RepoCronRun`.
All of it is done by `scripts/agent-readiness-scorer.ts`. **No model judgment** enters the score:
your job is to run the script and relay its output.

Run by the `agent-readiness` system cron, one task per repo, as
`/shipwright:agent-readiness --repo {repo}`. It is exempt from two points of the system-cron
contract (fix tasks and the repo doc); see "System-cron contract" in
[docs/task-store.md](../../../../docs/task-store.md).

## Setup: Parse Arguments

`--repo org/repo` is **required**. If it is missing, print the following and stop without
cloning, scoring or doing any other work:

```
Usage: /shipwright:agent-readiness --repo org/repo
```

## Step 1: Resolve a read-only checkout

Find the repo's clone by matching each `repos/*/` `origin` remote against `org/repo` (clone it
if none matches) and `git pull` it. Score that checkout directly; **never** create a branch,
worktree, commit or PR, and never edit a file in it.

## Step 2: Run the scorer

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/agent-readiness-scorer.ts" \
  --repo org/repo --root repos/<repo>
```

The script resolves the commit (`git rev-parse HEAD`), runs the file-based detectors and the
GitHub and task-store detectors, computes the level with `computeLevel`, posts the snapshot and
records the run (outcome `ok`, `metrics: {}`). A detector whose source is unreachable fails its
checks rather than aborting. It exits non-zero, after recording a `failed` run, if a post fails.
The runtime target is under 60 seconds per repo, excluding the clone.

## Step 3: Report

Print the script's one-line JSON (`level`, `passing`, `failing`) and the level name from the
catalogue. Do not interpret, adjust or re-score the result.

## Rules

- **No model judgment** in scoring: the result is whatever the script computes.
- **No task creation:** the cron queues no tasks and has no fix step; owners fix failing checks through their own crons.
- **No repo files:** nothing is written to the scanned repo and no doc PR is opened.
- **No local state:** the run and the snapshot live in the task store only.

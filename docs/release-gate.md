# Release gate runbook

Cross-repo work needs an explicit wait for a release. Instead of automation that mutates tasks, a plan inserts a **RELEASE GATE** task between the producer task (in `app-vitals/agent`) and the consumer task (in `app-vitals/shipwright`). Every gate task's description links here and repeats the short form below.

## The release chain the gate waits on

1. The producer PR merges in `app-vitals/agent` (the task reaches `merged`/`deployed`).
2. The agent `Release` workflow runs semantic-release and cuts `vX.Y.Z` (this needs a `feat:`/`fix:`/`perf:` commit — otherwise **no release is cut**), publishes the three npm packages and three images, then runs `Consumer smoke`.
3. The agent release dispatches `platform-release` in `app-vitals/shipwright`.
4. `platform-release` opens or updates the bump PR (branch `chore/platform-release`), waits for required checks (rerunning failed ones up to 3x), and admin-merges it.
5. **Done** when shipwright `main` pins `@app-vitals/agent-*` >= `X.Y.Z`.

## Gate behavior

Run the read-only pin check (no task-store calls):

```bash
scripts/check-platform-pin.sh <package> <minVersion>
# e.g. scripts/check-platform-pin.sh @app-vitals/agent-runtime 0.17.0
```

- **Exit 0** — shipwright `main` pins the package at >= `minVersion`. Mark the gate task `done`; the consumer task becomes ready through its dependency.
- **Exit 1** — not yet. The script prints the stuck stage (below). Leave the gate `pending` and report the stage; do **not** mark it `done` or `blocked`.
- **Exit 2** — usage error, the package is not pinned, or a `gh` call failed (auth, network); fix the invocation or environment and retry.
- **Stuck > 2h** after the producer merged: set `hitl` with a note naming the stage.

| `STAGE:` | Meaning |
|---|---|
| `no-agent-release` | agent has not cut `vX.Y.Z` |
| `no-bump-pr` | release published, no open `chore/platform-release` PR |
| `bump-pr-conflicting` | bump PR open but `CONFLICTING` |
| `bump-pr-red` | bump PR open and a check failed |
| `bump-pr-pending` | bump PR open, checks running or awaiting admin-merge |

## Watch list

- agent `Release` run and `Consumer smoke` (agent repo Actions). Red means fix it in agent; the gate keeps waiting.
- shipwright `platform-release` run, and any open issue titled **platform release bump failed**.

## Failure playbook

- **Red bump PR.** Usually the new package broke a shipwright check, which is a plan error: the producer change was not additive. The fix is a consumer task, then re-dispatch:
  `gh workflow run platform-release.yml -R app-vitals/shipwright -f version=X.Y.Z`
- **Bump PR `CONFLICTING`.** The workflow re-dispatches itself once; after that, re-dispatch by hand with the command above.
- **No release cut.** The producer commit lacked a `feat:`/`fix:`/`perf:` prefix.
- **Never** use `POST /tasks/:id/unblock` on a task whose PR already merged — it resets the task to `pending` and it can be re-run. Set it to `deployed`/`done` instead.

See also [Local cross-repo development](./local-platform-development.md) for how the platform bump works.

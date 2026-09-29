# Deploy Methodology Contract

The interface any subagent plugged into the "deploy" pipeline phase's swappable execution
step must satisfy — whether that's the built-in behavior (inline in
`plugins/shipwright/commands/deploy.md`; there is no separate `agents/*.md` file for deploy,
same as plan-session) or a custom, operator-supplied subagent swapped in via a per-agent,
per-phase `AgentPhaseMethodology` override (`phase -> subagentType or null`, phase value
`"deploy"`). The `/shipwright:deploy` command is the caller: it owns pre-flight (approval and
CI checks), the merge itself, claiming and releasing the `PullRequest` task-store record, every
task-store status PATCH derived from the execution step's output, and printing the final
handoff — none of that is delegated. The one task-store call that *is* delegated is renewing
the claim heartbeat mid-poll (see `PR_RECORD_ID` below): the claim's TTL expires before a
long pipeline watch finishes, and only the execution step knows how far along its own poll is.
Once the merge lands, the caller dispatches
whichever subagent is configured for the deploy phase with the inputs below and parses the
output shape below regardless of which concrete implementation produced it. A drop-in
replacement for the built-in execution step must accept exactly these inputs and return
exactly this output shape — the caller has no other integration point and does no
phase-specific adaptation.

`plugins/shipwright/commands/deploy.md`'s Steps 5 through 7 are the **reference
implementation** this contract was extracted from — no-pipeline detection, the post-merge CI
watch, the Deploy → Canary → Promote poll, stage-name validation against live workflows and
its SHA-only fallback, ARC desync handling, the canary-failure revert-PR flow, and the
post-promote health probe. Consult it for the full set of polling budgets, terminal-condition
heuristics, and progress-printing conventions a built-in implementation applies; this doc only
specifies the wire shape, not deploy policy or polling heuristics.

## Inputs

Inputs available at the point the swappable execution step begins — right after Step 4's
merge completes:

- **`SQUASH_SHA`** — the merged commit SHA, captured from `git refs/heads/main` (via
  `gh api repos/{org}/{repo}/git/refs/heads/main`) immediately after the squash merge
  completes. The source of truth for every subsequent poll — only runs whose `head_sha`
  matches this value are watched.
- **`org`/`repo`** — the target repository the PR was merged into.
- **`pr`** — the PR number.
- **`PR_TITLE`** — the PR title, captured in Step 2a.
- **`TASK_ID`** — the primary task id (`tasks[0]` from the task-store lookup), when a task is
  linked to this PR.
- **`TASK_IDS`** — the full space-separated list of every task on this PR, including the
  primary — a single PR can carry several bundled tasks opened together on one branch. Both
  `TASK_ID` and `TASK_IDS` are empty/absent in deploy-only mode (no task-store record found
  for this PR); the subagent must not assume a task is always linked.
- **`PR_RECORD_ID`** — the id of the `PullRequest` task-store record claimed pre-merge in
  Step 4a (`phase: "deploy"`). Used to renew the claim heartbeat (`POST
  /prs/$PR_RECORD_ID/heartbeat`) at roughly the midpoint of a long-running poll, since the
  claim's TTL is shorter than the full pipeline-watch budget. This renewal is the execution
  step's *only* task-store write — the claim itself, its release, and every status PATCH stay
  with the caller (reference implementation: the midpoint renewal inside Step 5's poll loop).
  Best-effort and skipped when absent, so an implementation must tolerate an empty value.
- **`deploy_started_at`** — the ISO timestamp captured at the start of Step 4, before the
  merge. Used to compute pipeline-duration timing (`pipeline_minutes`) in the output.
- **Resolved target-repo Deploy model** — the target repo's own `CLAUDE.md` `## Deploy model`
  section, already in context from the worktree checkout: either `direct`/`none` (no deploy
  pipeline — the execution step watches post-merge CI instead) or `staged` (a three-stage
  GitHub Actions pipeline, with optional custom stage names in place of the defaults
  `"Deploy"` / `"Canary"` / `"Promote to Prod"`). When the section is absent, ambiguous, or
  the reader isn't confident in the read, the execution step must never guess — it runs the
  Deploy-workflow-detection poll (Step 5a's 5-minute budget, the same poll the `direct`/`none`
  case skips) rather than assuming no pipeline exists, and only proceeds to the full staged
  poll if a Deploy workflow run is actually observed within that window; if none appears it
  falls through to the post-merge CI watch (Step 5c), same as the explicit no-pipeline path.

## Output

A single JSON object:

```json
{
  "success": true,
  "verdict": "promote_succeeded",
  "pipeline_minutes": 14,
  "pipeline_mode": "staged",
  "sha_only_fallback": false,
  "stages": [
    { "name": "Deploy", "run_id": "1234567", "conclusion": "success" },
    { "name": "Canary", "run_id": "1234568", "conclusion": "success" },
    { "name": "Promote to Prod", "run_id": "1234569", "conclusion": "success" }
  ],
  "failure_reason": null,
  "revert_pr_url": null,
  "health_check": {
    "status": "passed",
    "url": "https://<your-service-host>/health"
  }
}
```

- **`success`** — boolean. `true` on any terminal condition that represents a completed,
  non-blocked deploy (post-merge CI passed, a pending-timeout that still marks the task
  deployed, or Promote succeeded); `false` on any condition that leaves the task `blocked`.
- **`verdict`** — which specific terminal condition was reached, one of:
  `post_merge_ci_passed` / `post_merge_ci_failed` / `post_merge_ci_pending_timeout` (no-pipeline
  case, Step 5c) or `deploy_stage_failed` / `canary_failed` / `promote_skipped` /
  `promote_succeeded` / `pipeline_timeout` (staged case, Step 5b). Exactly one of these — the
  caller does not need to re-derive the outcome from `stages[]`.
- **`pipeline_minutes`** — elapsed minutes from `deploy_started_at` to the terminal condition,
  matching Step 8a's `floor((now - deploy_started_at) / 60)`.
- **`pipeline_mode`** — `"no-pipeline"` (Step 5a detected no Deploy workflow — watching
  post-merge CI instead) or `"staged"` (a Deploy → Canary → Promote pipeline was watched).
- **`sha_only_fallback`** — boolean. `true` when the resolved stage names from `CLAUDE.md`
  didn't match any live workflow and the execution step fell back to an unnamed, SHA-only
  watch for the remainder of the budget (Step 5b's stage-name-mismatch path); `false`
  otherwise, including always `false` when `pipeline_mode` is `"no-pipeline"`.
- **`stages[]`** — the workflow run(s) observed, each with:
  - `name` — the workflow name (`"Deploy"` / `"Canary"` / `"Promote to Prod"`, a repo's custom
    stage name, or the underlying CI/build workflow name in the no-pipeline case) — the
    GitHub Actions workflow `.name` value as the API returns it, not the internal stage label
    (the Promote stage's default workflow `.name` is `"Promote to Prod"`). `null` when
    `sha_only_fallback` is `true`, since there is no `.name` to match against in that mode.
  - `run_id` — the GitHub Actions run id.
  - `conclusion` — the run's terminal `conclusion` (`success`, `failure`, `cancelled`,
    `timed_out`, `skipped`, etc.), or `null` for a run still in flight at timeout.
  Empty when no run of any kind was ever observed (e.g. a `post_merge_ci_pending_timeout` or
  `pipeline_timeout` verdict where nothing ever appeared).
- **`failure_reason`** — a short, human-readable string on any non-`success` verdict, or
  `null` on success. Mirrors the exact wording the reference implementation writes into the
  task-store PATCH's `note`/`blockedReason` field for that terminal condition — e.g.
  `"Deploy stage failed — run ID: {id}"`, `"canary_blocked: Promote skipped after canary
  success"`, or `"Pipeline timeout after 30 minutes"`. The caller uses this string verbatim
  when it PATCHes `TASK_IDS` to `blocked` or the `PullRequest` record's `blockedReason`.
- **`revert_pr_url`** — the URL of the auto-opened revert PR, present only when `verdict` is
  `canary_failed` (Step 6: the code already reached prod when Canary failed, so a revert PR is
  opened automatically but never auto-merged). `null` for every other verdict.
- **`health_check`** — `{status, url}` from Step 7's post-promote probe, or `null` when
  `verdict` is not `promote_succeeded` (the probe only runs after Promote succeeds).
  `status` is `"passed"` (HTTP 200) or a description of the failure (e.g. `"503"` or
  `"unreachable"`). **One exception to that invariant:** when `sha_only_fallback` is `true`,
  the SHA-only watch has no `.name` to identify a Promote run, so its all-runs-green terminal
  condition reports `verdict: "promote_succeeded"` without ever reaching Step 7 — that path
  stops at the `status: "deployed"` update. So a `promote_succeeded` verdict carries a `null`
  `health_check` whenever `sha_only_fallback` is `true`; the probe is only guaranteed to have
  run when `sha_only_fallback` is `false`. This field is explicitly informational — it never changes `success` or
  `verdict`; the deploy is already recorded as successful by the time the probe runs, and a
  failing health check only prompts a human to investigate manually.

## Scope

This contract covers only the wire shape between the caller and the deploy-phase execution
subagent — what goes in, what comes back. It says nothing about polling intervals, budgets,
ARC-desync handling, or how a custom implementation decides to watch GitHub Actions runs;
those are the concrete implementation's concern (see `commands/deploy.md` Steps 5 through 7
for the reference implementation's full heuristics). It also says nothing about what the
caller does with the output afterwards: `/shipwright:deploy` continues to own claiming and
releasing the `PullRequest` task-store record, merging the PR, PATCHing `TASK_IDS`/the PR
record to `deploying` / `deployed` / `blocked` based on `success`/`verdict`/`failure_reason`,
surfacing the `revert_pr_url` the subagent reports, and printing the final handoff block. The
subagent does not merge the PR, does not claim or release the `PullRequest` record, and does
not write any task-store status. Its only writes are the mid-poll heartbeat renewal
(`PR_RECORD_ID`) and, on canary failure, opening the revert PR it then reports back via
`revert_pr_url` — everything else it does to GitHub is read-only observation of the workflow
runs needed to determine its own output.

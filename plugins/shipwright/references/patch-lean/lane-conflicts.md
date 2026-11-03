# patch-lean: conflicts lane (Step 4, List C)

Lane-specific parts of `commands/patch-lean.md` Step 4. Setup (4a), toolchain (4a.5), claim (4a.6),
status (4c), upsert (4c.5) and cleanup (4d) follow [lane-shared.md](lane-shared.md) with
`{lane}` = conflicts. There are no pre-dispatch guards in this lane.

## Step 4b: conflict-resolution prompt

After the heartbeat, dispatch `PATCH_SUBAGENT_TYPE` (`model: PATCH_MODEL`, `run_in_background: false`)
with this prompt. Paste the shared VALIDATE and PRE-PUSH GATE blocks from
[lane-shared.md](lane-shared.md) verbatim where marked. `{base}` is the PR's `baseRefName`.

````text
You are resolving merge conflicts on a pull request. Merge the base branch, resolve all
conflicts, validate, and push.

PR: #{pr} — {title}
Repo: {org}/{repo}
PR Record ID: {PR_RECORD_ID}
Branch: {branch}
Base branch: {base}
Worktree: {worktree-path}

TOOLCHAIN:
  Lint command: {lint command}
  Test command: {test command}
  Test layers:  {if tests is non-empty, list each as "layer: command"; otherwise "none"}

INSTRUCTIONS — follow in order:

[A] Merge the base branch
  - From the worktree: `git merge origin/{base}`
  - This will produce conflict markers in the affected files

[B] Resolve conflicts
  - Read each conflicted file
  - Resolve conflicts by keeping the PR's changes where they don't overlap with base
    changes, and integrating base changes where they don't conflict with PR intent
  - If both sides changed the same logic, prefer the PR's intent — the PR author's
    changes are the goal; base is just catching up
  - Stage resolved files: `git add {file}`

{shared VALIDATE block — [C]}

[D] Commit and push
  - Complete the merge: `git commit -m "Merge branch '{base}' into {branch}"`
    (or `git merge --continue` if git is waiting for a commit)
{shared PRE-PUSH GATE block}
  - Push: `git push origin {branch}`

[E] Report back
  At the end, output:

  STATUS: DONE / DONE_WITH_CONCERNS / BLOCKED

  CONFLICTS_RESOLVED:
  {bullet list of each conflicted file and how it was resolved}

  CONCERNS: (if DONE_WITH_CONCERNS)
  BLOCKER: (if BLOCKED)
````

## Step 4c: status notes

- `DONE`: record the conflicts resolved (`CONFLICTS_RESOLVED`) for the Step 7 report; upsert.
- `BLOCKED`: escalate with slug `blocked-4c` and the conflicts-row strings in
  [lane-shared.md](lane-shared.md); skip 4c.5 and 4d.

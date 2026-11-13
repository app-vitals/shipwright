# Cold-run rehearsal log (agent-driven, not the CRQ-5.1 human run)

- **Date:** 2026-11-13
- **Machine:** fresh Compute Engine VM, Ubuntu 24.04, e2-standard-2, no service account. Started with only `git`. Deleted after the run.
- **Doc followed:** `docs/quickstart.md` at shipwright `main` (`df187ce68`)
- **Versions:** Claude Code 2.1.323, Docker 29.9.3 (compose v5.7.1), gh 2.104.0, Node 22.23.5, shipwright plugin from `main`
- **Target repo:** a private scratch repo holding a tiny dependency-free Node HTTP server with two tests
- **Spec:** "Add a `/health` endpoint that returns `ok`."
- **Driver:** an agent typing into a real interactive Claude Code session over tmux. Steps 1 and 3 to 5 were typed as slash commands, as the doc says.

## Result

All five steps passed. The run ended with a built and reviewed pull request on the scratch repo: `GET /health` plus two tests and a README line, review posted with verdict APPROVE and no findings.

## Timing

Wall times include fixed waits the driver inserted between keystrokes, so they are upper bounds. "Model time" is what Claude Code itself reported.

| Step | Doc estimate | Wall time | Model time | Outcome |
|---|---|---|---|---|
| Prerequisites (Docker, gh, Node, Claude Code) | 10–20 min | 1 min 32 s | n/a | pass |
| 1. Install plugin | 1 min | 1 min 37 s | n/a | pass |
| 2. Local task store | 2–5 min | 1 min 39 s (clone 49 s, script 50 s) | n/a | pass |
| 3. Plan-session | 3–10 min | 4 min 34 s | under 1 min across three turns | pass |
| 4. Dev-task | 10–30 min | about 3 min 15 s | 3 min 5 s | pass |
| 5. Review | 3–10 min | 2 min 48 s | 1 min 7 s | pass |
| **Steps 1–5 total** | **19–56 min** | **14 min 15 s** | | |

## Findings

Nothing stopped the run. Every item below is something the quickstart does not prepare a newcomer for, or something the model had to work around.

### Would likely stop or confuse a person

1. **`bun` is required but not listed.** `/shipwright:review` runs plugin scripts with `bun`. It was not installed, and the quickstart's prerequisites do not mention it. The model fell back to `node --experimental-strip-types` and skipped two helper scripts. That fallback only works on a recent Node; on a machine without one the review step would fail.
2. **Task claim fails with the local token.** The task store's claim endpoint returned 400 (`claimedBy` is required) in both dev-task and review. The model retried with a made-up `claimedBy` value and continued. The plugin should send it.
3. **Plan-session stops twice for input the doc never mentions.** It asks you to confirm the auto-detected repo, then to approve the design and task breakdown. Neither is in step 3.
4. **Plan-session opens its own pull request.** A docs-only "plan PR" (#1) appears on the user's repo before the build PR (#2). The doc says nothing about it, and it is left open at the end.
5. **First-run Claude Code prompts.** Theme choice, a security notice, and a "trust this folder" prompt whose default answer is "No, exit". Pressing Enter there closes Claude Code. Not Shipwright's doing, but a one-line note would help.
6. **`/plugin install` opens a scope chooser** (user, project, local). The doc shows it as a single command with no follow-up.

### Misleading output

7. **"The execution cron will pick up ready tasks automatically."** Plan-session prints this at the end. There is no cron in the quickstart path; the user runs dev-task by hand in step 4.
8. **Repo-location warning.** Plan-session says dev-task will look for the source tree under `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/<repo>`. The repo was not there and dev-task worked anyway, so the warning is either wrong or irrelevant for this path.
9. **"The plan-viz link was skipped because SHIPWRIGHT_ADMIN_APP_BASE_URL is unset."** Noise for a local user.

### Leftovers on the user's machine and repo

10. **Untracked files in the user's checkout:** `planning/first-pr/PLAN.md` and `state/reviews/` (review notes and JSON) are left untracked on `main`.
11. **A worktree is left behind** at `~/worktrees/<repo>-<branch>`. The doc does not say where the work happens or how to clean up.

### Smaller points

12. **The repo clone took 49 seconds**, half of step 2, just to get one script. A shallow clone or a `curl`-able script would cut it.
13. **Token scope is unspecified.** The doc says "authenticated gh". With a fine-grained token limited to Contents and Pull requests, the CI check hit a 403 on the Actions API and the model inferred "no CI" from the missing workflows folder. The doc should name the scopes needed.
14. **Self-review cannot approve.** The review was posted as a comment with "Verdict: APPROVE" because GitHub blocks approving your own PR. Every solo newcomer will hit this; the doc's step 5 could say so.
15. **The reviewer did not run the tests.** It inferred the "npm test passes" criterion from the code.

## What this run does not show

- It was driven by an agent that already knew what each prompt meant. Items 3, 5 and 6 cost it nothing; they may cost a person minutes.
- The spec was a five-line change in a 30-line repo. Dev-task time will grow with a real codebase.
- Claude Code ran in its default auto permission mode and was never asked to approve a tool call. A user in a stricter mode will see prompts.
- One run. No repeat to check variance.

# Cold-run log (CRQ-5.1, human run)

- **Date:** 2026-11-14
- **Who:** a maintainer who had not followed this quickstart before, typing every command by hand.
- **Machine:** fresh Compute Engine VM, Ubuntu 24.04, e2-standard-2, no service account. Pre-installed: Docker, gh, git, Node, Claude Code. Not pre-installed and not signed in: Bun, `gh`, Claude Code, git identity. Deleted after the run.
- **Doc followed:** `docs/quickstart.md` at shipwright `main` (ffe788ee3), read in a browser beside the terminal.
- **Versions:** Claude Code 2.1.325, Docker 29.9.3, gh 2.104.0, Node 22.23.5, Bun 1.4.4, shipwright plugin 1.469.1
- **Target repo:** a private scratch repo holding a tiny dependency-free Node HTTP server with two tests
- **Spec:** "Add a `/health` endpoint that returns `ok`."
- **Observer:** an agent in a separate chat kept this log, read timestamps off the VM and GitHub, and answered the person's questions when they were stuck. Every answer is recorded below as a finding, because a newcomer has nobody to ask.

## Result

All five steps ended in the right place: a plan PR, a build PR adding `GET /health` with two tests (17 lines, 2 files), and a review posted on the build PR with "Verdict: APPROVE".

**Total: 48 minutes from first connection to the posted review, against the 15-minute target. The target was missed by 33 minutes.**

The Shipwright commands themselves took about 13 minutes. The other 35 minutes went to places where the doc left the person unsure what to do next. The person was stuck five times and needed outside help each time; without it the run would have stopped at step 2 or gone wrong at step 3.

## Timing

Times are from machine and GitHub timestamps (UTC). "Command time" is the part spent waiting on Shipwright or the model; the rest is the person reading, deciding, or waiting for an answer from the observer.

| Step | Start | End | Elapsed | Command time | Outcome |
|---|---|---|---|---|---|
| Connect, sign in to Claude Code, first-run prompts | 12:02 | 12:05:31 | 3 min 30 s | n/a | pass |
| 1. Install plugin | 12:05:31 | 12:06:54 | 1 min 23 s | 1 min 10 s | pass after one failed paste |
| 2. Local task store | 12:07:30 | 12:14:30 | 7 min | 1 min 31 s | pass after help (findings 2, 3) |
| Prerequisites found missing: `gh auth login`, Bun, clone the repo | 12:15 | 12:23 | 8 min | n/a | pass after help (findings 4, 5) |
| 3. Spec and plan-session | 12:23:54 | 12:35:59 | 12 min 5 s | 4 min 53 s | pass after a wrong turn (finding 6) |
| Wait for the observer to confirm the task id | 12:35:59 | 12:41:39 | 5 min 40 s | n/a | |
| 4. Dev-task | 12:41:39 | 12:45:11 | 3 min 32 s | 3 min 32 s | pass |
| Wait | 12:45:11 | 12:48:43 | 3 min 32 s | n/a | |
| 5. Review | 12:48:43 | 12:50:16 | 1 min 33 s | 1 min 33 s | pass |
| **Total** | **12:02** | **12:50:16** | **48 min** | **about 12 min 40 s** | |

The two waits are partly an artifact of this run: the person paused to report to the observer and wait for a reply. A solo run would not have them, but it would not have had the answers either.

## Failures and findings

### Stopped the person; needed outside help

1. **Step 1: pasting both plugin commands at once fails silently.** The doc shows `/plugin marketplace add …` and `/plugin install …` in one code block. Copying the block and pasting it submits one command with the second line as an argument; Claude Code prints nothing and nothing is installed. The person had to work out that each line is its own command.
2. **Step 2: the second code block looks like commands to run.** The `export` block with `<printed token>` reads as the next thing to paste. The person could not tell whether step 2 was finished after the script, or whether the block was an example. Their words: "Is that all there is for step 2? … This is confusing."
3. **Step 2: the doc never says where to be.** Step 1 leaves you inside Claude Code. Step 2 says "in a terminal". The person pasted the `git clone … local-store.sh` lines into the Claude Code prompt (the model ran them, so the store started), then could not see how to "run the export lines in the shell you launch Claude Code from" while already inside it: "Am I SSHing in again? This is very unclear." The answer (exit, export, relaunch) is not in the doc. The person's suggestion: the script should write the variables to a file and the doc should say "exit, then source this file"; copying a token by hand a second time makes no sense.
4. **The Prerequisites table was passed over, and nothing caught it.** On reaching step 3 the machine had no `gh` login, no Bun, and no clone of the target repo, and Claude Code was running in the home folder. Steps 1 and 2 succeed without any of these, so the gap only shows later. The table reads as a list of things you already have, not as steps to do.
5. **Bun was installed but not on PATH.** The installer edits the shell profile; the already-open shell, and the Claude Code started from it, did not see `bun` until the shell was reloaded and Claude Code restarted. The doc links to the installer and says nothing about reloading.
6. **Step 3 went off the Shipwright path with one word.** The person asked Claude Code to write the spec, then believed they had run `/shipwright:plan-session first-pr` and answered a prompt with "proceed". The session record shows the slash command was never submitted. The model read "proceed" as "build it" and implemented the endpoint directly on `main`, with passing tests and no PR. Nothing told the person they had left the path; the observer caught it from the machine. Recovery was `git checkout -- src test` and running the slash command again (about five minutes lost).

### Worked around by the model, never shown to the person

7. **Git identity was unset.** The plan-PR commit failed with "Author identity unknown". The model set an identity for the commit and carried on without asking. Prerequisites do not mention `git config user.name` / `user.email`, and a silent choice of commit author is not something a newcomer should discover later.

### Smaller points

8. **The example task id misleads.** The doc says "for example `FP-1.1`" and step 4 shows `/shipwright:dev-task FP-1.1`. Plan-session chose `HLT-1.1`. The person asked the observer which id to use.
9. **Leftovers match the Clean-up section:** untracked `planning/` and `state/reviews/` in the checkout, one worktree under `~/worktrees/`, the open plan PR, and the running task store.

## What the earlier fixes changed

Compared with the agent-driven rehearsal of 2026-11-13 (`REHEARSAL-LOG.md`):

- **Task claim works.** Dev-task claimed the task as `local` with no 400 (CRQ-6.2).
- **Review used Bun** once it was on PATH, with no fallback to Node (CRQ-6.1).
- **Plan-session's two confirmations and the plan PR were expected.** The person answered both without asking (CRQ-6.3).
- **The trust-folder prompt and the scope chooser caused no trouble** (CRQ-6.3).
- **The self-review comment with a verdict line was as documented.**

## What this run does not show

- The observer answered within a minute or two each time. A solo newcomer would have spent longer on findings 2 to 5, and may not have noticed finding 6 at all.
- The observer's first brief already named the scratch repo and the suggested spec, so the run did not test choosing either.
- The spec was a five-line change in a 30-line repo. Dev-task and review will be slower on a real codebase.
- One person, one run.

## Follow-ups filed

| Task | Covers |
|---|---|
| CRQ-7.1 | Reorder and rewrite the first-PR path in `docs/quickstart.md`: task store before Claude Code, one command per code block, prerequisites as commands to run, the spec step, the task id wording (findings 1 to 6, 8) |
| CRQ-7.2 | `scripts/local-store.sh` writes the two variables to an env file and prints one `source` line (findings 2, 3) |
| CRQ-7.3 | Preflight in plan-session and dev-task: stop with one clear message when `gh` is not authenticated, git identity is unset, or the folder is not a repo with a GitHub remote (findings 4, 7) |

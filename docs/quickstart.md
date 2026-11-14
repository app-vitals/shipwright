# Quickstart

This path takes you from nothing to a **reviewed pull request on your own repo**, driven by Shipwright: plan a tiny spec, let `/shipwright:dev-task` build it, then `/shipwright:review` the PR. The metrics dashboard and the full dev stack are optional extras, covered [below](#optional-metrics-dashboard-no-secrets-needed).

## Before you start

Everything in this block and in Step 1 happens in a plain terminal. Claude Code is not opened until Step 2, and you never have to leave it once it is open.

You need [Claude Code](https://www.anthropic.com/claude-code), [Docker](https://docs.docker.com/get-docker/) (with the compose plugin), [gh](https://cli.github.com), [git](https://git-scm.com/downloads) and [Bun](https://bun.sh). Run each check below in your terminal; fix any that fails before moving on.

**Docker** runs the local task store. Check it:

```bash
docker compose version
```

**gh** opens the PR in Step 4 and reads it in Step 5. Check it is signed in, and run `gh auth login` if it is not:

```bash
gh auth status
```

**Bun** runs the `/shipwright:review` helper scripts. The Bun installer only edits your shell profile, so open a new terminal (or `source` the profile) after installing, then check it is on your PATH:

```bash
bun --version
```

**git** needs an identity so dev-task can commit. Both lines must print a value; set any that is empty with `git config --global`:

```bash
git config user.name
git config user.email
```

**A small repo you can push to** is where the first PR lands. A scratch repo is ideal. Create one and `cd` into it:

```bash
gh repo create first-pr-demo --private --clone
cd first-pr-demo
```

To use a repo you already have instead, clone it with `gh repo clone` and `cd` into it. Either way, leave this terminal open: you launch Claude Code from it in Step 2.

If you authenticate `gh` with a fine-grained token instead of `gh auth login`, give it read/write on **Contents** and **Pull requests** for your repo, plus read on **Actions** if the repo has CI. Without Actions read, the CI check on the PR returns a 403 and Shipwright cannot tell whether CI passed.

## Step 1 — Start the task store and write the spec (in your terminal)

Shipwright tracks tasks in a task store. Clone this repo somewhere outside your own repo and run the one-command local store:

```bash
git clone --depth 1 https://github.com/app-vitals/shipwright.git ~/shipwright
~/shipwright/scripts/local-store.sh
```

`--depth 1` skips the git history; the script needs nothing from it. It needs only Docker and curl, starts Postgres and the task-store image, waits for it to be healthy, and writes the task-store URL and token to an env file (`~/.shipwright/local-store.env` by default, mode 600). Its last line of output is the `source` command for that file. Run it in the same terminal; this is what lets Claude Code reach the store:

```bash
source ~/.shipwright/local-store.env
```

Re-running the script is safe; `~/shipwright/scripts/local-store.sh --down` removes the containers, volume, token and env file.

Now write the spec. From inside your repo (the `cd` above), one command creates it, small enough for one or two tasks:

```bash
mkdir -p planning/first-pr
cat > planning/first-pr/PRODUCT-SPEC.md <<'SPEC'
# First PR: health endpoint

Add a `/health` endpoint that returns `ok`.
SPEC
```

## Step 2 — Launch Claude Code and install the plugin (inside Claude Code)

Still in the same terminal, start Claude Code:

```bash
claude
```

On a first launch, Claude Code asks a few things before you reach a prompt: a theme choice, a security notice, and a "trust this folder" prompt whose default answer is **No, exit**. Choose "Yes, I trust this folder"; pressing Enter on the default closes Claude Code.

Installing is two slash commands. Run them **one at a time**: pasting both together fails silently. First add the marketplace:

```text
/plugin marketplace add app-vitals/shipwright
```

When that finishes, run the install:

```text
/plugin install shipwright@shipwright
```

`/plugin install` opens a scope chooser (user, project, local); pick **user** scope so the plugin is available in every repo.

## Step 3 — Plan the spec (inside Claude Code)

The first thing you type in Claude Code is the slash command:

```text
/shipwright:plan-session first-pr
```

Check that `/shipwright:plan-session` appears in the transcript as the command you ran. If you answer a question with "proceed" or "yes" before running it, the model builds the change directly and no PR is opened; if that happens, start over by typing the command.

Plan-session reads the spec, explores your repo, and writes a task breakdown into the task store. It stops twice to ask for input:

1. **Confirm the detected repo.** It prints the repo it found from your git remote; confirm it is the right one.
2. **Approve the design and task breakdown.** Review the proposed design and tasks, then approve them (or ask for changes).

It also opens a docs-only **plan PR** on your repo with the plan files, before the build PR in step 4. That plan PR stays open until you merge or close it.

Plan-session picks its own task id prefix, so the id you get will not match any example in this doc. Use the id it prints. It may also end by saying an execution cron will pick up ready tasks; with no agent configured, as in this path, nothing does, so you run `/shipwright:dev-task` yourself in the next step.

## Step 4 — Build it (inside Claude Code)

Run dev-task with the id from step 3. The id below is only an example; replace it with yours:

```text
/shipwright:dev-task FP-1.1
```

`dev-task` claims the task, works in a branch worktree, implements and tests it, and opens a pull request on your repo. It prints the PR number and URL when it finishes.

## Step 5 — Review the PR (inside Claude Code)

Run review with the PR number dev-task printed. The number below is only an example; replace it with yours:

```text
/shipwright:review 1
```

Shipwright reviews the diff and reports its findings; depending on policy it posts them to the PR as a GitHub review. GitHub does not let you approve your own pull request, so on a solo repo the review is posted as a comment with a verdict line (for example `Verdict: APPROVE`) rather than as an approving review. You now have a planned, built, and reviewed PR on your own repo.

## Expected time

The target for steps 1 to 5 was 15 minutes. **That target was not met on this version of the doc.** A human cold run of the first-PR path took **48 minutes** end to end, of which about **13 minutes** was command time; the rest went on working out what to do next, and the reader needed outside help five times. This ordering is the response to that run.

An earlier agent-driven rehearsal, on a fresh Ubuntu VM with Docker already available and a tiny dependency-free Node repo (a five-line `/health` endpoint change), took **14 min 15 s** of wall time. Treat both as data points, not guarantees: a real codebase makes dev-task and review slower, and the rehearsal figures include fixed waits between keystrokes.

| Step | What happens | Measured (rehearsal, tiny repo) | Expect more when |
|---|---|---|---|
| Before you start | Install Claude Code, Docker, gh, Bun | 1 min 32 s (checking tools already present) | You install them from scratch (plan for 10–20 min, once) |
| 1. Task store + spec | Image pull + Postgres boot on first run | 1 min 39 s (with a full clone; a shallow clone is faster) | Your network is slow |
| 2. Claude Code + plugin | Marketplace add + install | 1 min 37 s | — |
| 3. Plan-session | Plan a tiny spec | 4 min 34 s | The spec or repo is larger |
| 4. Dev-task | Implement, test, open PR | about 3 min 15 s | The change is larger or the test suite is slow |
| 5. Review | Review the PR | 2 min 48 s | The diff is larger |

The earlier planning estimate for steps 1 to 5 was 19 to 56 minutes; that range is still the safer one to plan around for a real repo.

## Clean-up

The path leaves a few things behind:

- **A worktree** from dev-task at `~/worktrees/<repo>-<branch>` (or under `$SHIPWRIGHT_WORKTREE_DIR`). Remove it with `git worktree remove <path>` once the PR is merged.
- **Untracked files in your checkout:** `planning/first-pr/` and `state/reviews/`. Delete them or add them to `.gitignore`.
- **The open plan PR** from step 3. Merge or close it.
- **The local task store**, when you are finished: `~/shipwright/scripts/local-store.sh --down`.

## What CI does not cover

The checks that run on Shipwright's pull requests exercise the deterministic shell scripts. They do **not** run the interactive parts of this path: installing the plugin inside Claude Code, running the `/shipwright:*` slash commands against a live model, or pushing a PR to your repo and reviewing it. Treat those steps as manually verified, and expect behavior to depend on your Claude Code version, your `gh` authentication, and your repo.

---

## Optional: metrics dashboard (no secrets needed)

> Get the Shipwright Harness metrics dashboard running locally in one prompt — offline by default, no external accounts or secrets.

### What this runs

The **metrics dashboard** runs locally in **offline mode**: it serves from fixtures with **no external services needed**, giving you a dashboard at `http://localhost:3460/dashboard` from a single copy-paste prompt. You do not need it to complete the first-PR path above.

### Prerequisites

| Tool | Why | Install |
|---|---|---|
| **Claude Code** | Runs the `/plugin install` step of the prompt. Not needed by `scripts/quickstart.sh`. | <https://www.anthropic.com/claude-code> |
| **git** | Clone the repo. | <https://git-scm.com/downloads> |
| **Bun** | Runtime + package manager for all workspaces. | <https://bun.sh> |
| **go-task** (`task`) | The single local entrypoint (`task setup`, `task dev`). | <https://taskfile.dev/installation/> |

### The one-prompt onboarding

Paste this into a **Claude Code** session pointed at where you want to work. It sequences **two execution contexts** — shell steps run in a terminal, and one step runs *inside* the Claude Code session:

```text
Set up Shipwright Harness locally and open the metrics dashboard.

1. In a terminal, run:
     git clone https://github.com/app-vitals/shipwright.git && cd shipwright && ./scripts/quickstart.sh
   This checks prerequisites, installs dependencies (task setup), and starts the
   metrics dashboard in offline mode (no accounts or secrets needed). Leave it running.

2. Inside this Claude Code session, install the plugin:
     /plugin marketplace add app-vitals/shipwright
     /plugin install shipwright@shipwright

3. Open the dashboard in your browser:
     http://localhost:3460/dashboard
```

### Which lines run where

| Step | Where it runs | Command |
|---|---|---|
| 1. Clone + bootstrap + serve | **Terminal** (shell) | `git clone … && cd shipwright && ./scripts/quickstart.sh` |
| 2. Install the plugin | **Inside the Claude Code session** | `/plugin marketplace add app-vitals/shipwright`, then `/plugin install shipwright@shipwright` |
| 3. Open the dashboard | **Browser** | `http://localhost:3460/dashboard` |

The distinction matters: step 1 is a shell command, step 2 is a slash command that only works **inside** an interactive Claude Code session (it is not a terminal command).

### What `scripts/quickstart.sh` does

Run it from **inside** the cloned repo (the prompt's step 1 clones and `cd`s for you first). It is **idempotent** — safe to re-run:

1. Verifies prerequisites (`git`, `bun`, `task`) and fails with an install pointer if any is missing.
2. Runs `task setup` (idempotent `bun install` across all workspaces).
3. Starts the dashboard with `task dev` (the dev supervisor; Ctrl-C stops it) and points you at `http://localhost:3460/dashboard`.

### Offline by default

`task dev` (and `task api` / `task ui`) bake in `METRICS_OFFLINE=true`. In offline mode the dashboard serves from fixtures, so you need **no external services** to run it. Live external calls only happen when you explicitly set the relevant env vars — local-first is the default.

### CI / testing: `QUICKSTART_SKIP_SERVE`

The final `task dev` step is long-running (it blocks while the server runs), which would hang CI. Set the `QUICKSTART_SKIP_SERVE` env var to a non-empty value to run every deterministic step (prereq checks + `task setup` + the next-steps message) and then exit 0 **without** starting the server:

```bash
QUICKSTART_SKIP_SERVE=1 ./scripts/quickstart.sh
```

This is primarily for CI and the smoke test (`scripts/quickstart.smoke.test.ts`) — it lets the deterministic onboarding path be verified without blocking on a live server. In normal use, leave it unset.

### What this doesn't cover automatically

The two networked / interactive steps of the prompt are **not** part of the script (and are not run in CI):

- The `git clone` itself — it lives in the prompt's shell line, before the script runs.
- The `/plugin marketplace add app-vitals/shipwright` and `/plugin install shipwright@shipwright` steps — they run inside an interactive Claude Code session, not a shell.

Both are documented in the prompt above; only the deterministic shell portion is scripted and tested.

---

## Optional: full dev stack (agent chat turn from clone)

Run the complete local stack — metrics dashboard, admin UI, and the Shipwright agent in Docker — so you can send a real chat turn and see it round-trip.

### Prerequisites

| Tool | Why | Install |
|---|---|---|
| **git** | Clone the repo. | <https://git-scm.com/downloads> |
| **Bun** | Runtime + package manager. | <https://bun.sh> |
| **go-task** (`task`) | Single local entrypoint. | <https://taskfile.dev/installation/> |
| **Docker** | Runs the agent in an isolated container. | <https://docs.docker.com/get-docker/> |
| **tmux** | `task stack` multiplexes the 6 panes. | `brew install tmux` / `apt install tmux` |
| **PostgreSQL** | Admin service DB (local). | `brew install postgresql@18` / `apt install postgresql` |
| **Claude Code** | Runs the `/plugin install` step. | <https://www.anthropic.com/claude-code> |

### Step 1 — Clone and install

```bash
git clone https://github.com/app-vitals/shipwright.git
cd shipwright
task setup
```

### Step 2 — Launch the stack

```bash
task stack
```

First run: `task stack` finds no `state/dev-agent.env`, auto-creates it from `state/dev-agent.env.example`, and exits with a reminder to fill in your auth token. Open `state/dev-agent.env` and set **one** of:

- **`CLAUDE_CODE_OAUTH_TOKEN`** — get it by running `claude /oauth-token` in Claude Code (recommended for personal development)
- **`ANTHROPIC_API_KEY`** — from <https://console.anthropic.com/> → API Keys

`state/dev-agent.env` is git-ignored — it never leaves your machine. Then re-run `task stack`.

This opens a tmux session (`shipwright`) with 6 panes:

| Pane | What | URL |
|---|---|---|
| metrics | Dashboard (fixtures mode) | <http://localhost:3460/dashboard> |
| admin | Admin CRUD API + UI | <http://localhost:3001/admin> |
| task-store | Task queue service (Postgres-backed) | <http://localhost:3002> |
| chat-svc | Chat service (threads/messages + tokens) | <http://localhost:3003> |
| agent | Shipwright agent in Docker | _(terminal)_ |
| logs | Scratch shell | _(terminal)_ |

A browser window opens automatically to the admin dev-login page. The **agent** pane does not start a container yet — `task stack` creates zero agents automatically. It prints a pointer and waits.

### Step 3 — Create your agent

In the admin console, go to **Agents → New** (<http://localhost:3001/admin/agents/new>) and create an agent, picking a type from the picker (e.g. **Coding Agent**).

Leave the runtime on **Self-hosted** — `task stack` runs the agent's container for you in the agent pane. (The **Provisioned in-cluster** option is disabled here anyway: it needs `SHIPWRIGHT_K8S_PROVISIONING`, which only the Helm chart sets. See [deploy-kubernetes.md](./deploy-kubernetes.md) for that path.)

No Slack or GitHub credentials are needed — you'll talk to the agent from the Chat tab in Step 4. Both are optional inline fields on the New Agent form; you can connect either one later from the agent's detail page if you prefer.

The agent pane's wait-loop polls the database and detects the new agent automatically — no stack restart needed. Once detected, it seeds the agent's chat token and starts the Docker container with that agent's id.

Relaunching the stack later with an agent already created proceeds immediately — the wait-loop resolves on its first check, so you never need to delete and recreate an agent just to restart `task stack`.

### Step 4 — Send a chat turn

Open the **Chat** tab in the admin console (<http://localhost:3001/admin/chat>), select the agent you created, create a thread, and send a message. The turn should round-trip through the Docker agent: the agent's chat poll loop claims the message from the chat service, runs it through Claude, and posts the reply back into the thread.

### Stopping the stack

```bash
tmux kill-session -t shipwright
```

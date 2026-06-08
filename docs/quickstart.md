# Quickstart

Get from zero to a running Shipwright Harness dashboard in a few minutes.

## Prerequisites

You need two tools installed before you begin:

- **bun** — JavaScript runtime and package manager  
  Install: https://bun.sh
- **go-task** — task runner (`task` CLI)  
  Install: https://taskfile.dev

Verify both are available:

```sh
bun --version
task --version
```

## Steps

### 1. Clone the repository

```sh
git clone https://github.com/app-vitals/shipwright.git
cd shipwright
```

### 2. Run the quickstart script

```sh
./scripts/quickstart.sh
```

This script:

- Checks that `bun` and `task` are available (exits with a clear error if not).
- Runs `task setup` to install all dependencies across all workspaces.
- Is idempotent — safe to run multiple times.

To check prerequisites only (no installs, no side effects):

```sh
./scripts/quickstart.sh --check
```

Exit code 0 means all prerequisites are met.

### 3. Start the metrics dashboard

```sh
task api
```

This starts the metrics dashboard in offline mode (no external credentials needed).  
Open your browser to: **http://localhost:3460/dashboard**

### 4. Install the Shipwright plugin in Claude Code

Inside a Claude Code session (in any repository you want to use Shipwright with):

```
/plugin install shipwright@app-vitals/shipwright
```

This installs the `shipwright` plugin, giving you the full suite of planning, execution, review, and deploy commands.

---

## One-prompt flow (copy-paste)

The shell steps and plugin install in a single sequence:

```sh
git clone https://github.com/app-vitals/shipwright.git
cd shipwright
./scripts/quickstart.sh
task api
```

Then, in Claude Code:

```
/plugin install shipwright@app-vitals/shipwright
```

---

## What's next

- Run `task dev` to start the dev supervisor (metrics + Ctrl-C kills all children).
- Read [`docs/architecture.md`](./architecture.md) for a tour of the three-artifact design.
- See the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones) for the live roadmap.
- Explore the plugin commands: `/shipwright:brainstorm`, `/shipwright:plan-session`, `/shipwright:dev-task`, `/shipwright:review`, `/shipwright:deploy`.

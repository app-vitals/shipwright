# Quickstart

Get from zero to a running local Shipwright dashboard in under five minutes.

## Prerequisites

| Tool | Install |
|---|---|
| [Bun](https://bun.sh) | `curl -fsSL https://bun.sh/install \| bash` |
| [go-task](https://taskfile.dev/installation/) | `sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b /usr/local/bin` |
| [Claude Code](https://www.anthropic.com/claude-code) | `npm install -g @anthropic-ai/claude-code` |

## Steps

### 1. Clone and run system setup

```bash
git clone https://github.com/app-vitals/shipwright.git
cd shipwright
./scripts/quickstart.sh
```

`quickstart.sh` checks that `bun` and `task` are installed, then runs `bun install`. It's idempotent — safe to run again at any time.

### 2. Open Claude Code and install the plugin

Open Claude Code in the repo directory:

```bash
claude
```

Inside the Claude Code session, install the Shipwright plugin:

```
/plugin install shipwright@app-vitals/shipwright
```

### 3. Start the dev server

Still inside Claude Code (or a terminal in the same directory):

```
task dev
```

The dev supervisor starts the metrics API and opens the dashboard at **http://localhost:3460/dashboard**.

---

## Copy-paste session prompt

Once the plugin is installed, paste this into a new Claude Code session to orient the agent and start the workflow:

```
I've just installed the Shipwright plugin. Please:
1. Run /shipwright:brainstorm to start a new feature idea, OR
2. Run /shipwright:plan-session if I already have a product spec, OR
3. Run /shipwright:dev-task to pick up the next ready task from the queue.

Use `task dev` to keep the local dashboard running at http://localhost:3460/dashboard so I can track pipeline metrics as we work.
```

---

## Troubleshooting

**`bun: command not found`** — Install Bun: https://bun.sh

**`task: command not found`** — Install go-task: https://taskfile.dev/installation/

**`/plugin install` not recognized** — Make sure you're inside a Claude Code session (`claude` in your terminal), not a regular shell.

**Dashboard doesn't load** — Confirm `task dev` is running. The metrics API defaults to port 3460; check for port conflicts if it fails to start.

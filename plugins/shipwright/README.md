# Shipwright v4.29.0

A structured dev pipeline plugin for Claude Code. Plan sessions, execute tasks, run autonomous dev loops, perform multi-agent code reviews, and conduct integrated project research — for any software project.

A shipwright builds ships. This one ships software.

## Installation

```
/plugin install shipwright@app-vitals/shipwright
```

## The Pipeline

```mermaid
flowchart LR
    PS["/plan-session"] -->|"Task Breakdown"| DT["/dev-task"]
    DT -->|"Pull Request"| RV["/review"]
    RV --> M["✓ Merged"]
    DT -.->|"--merge\nautomated"| M

    style PS fill:#1e2d52,stroke:#4f8ef7,color:#c9d1e0
    style DT fill:#1e2d52,stroke:#4f8ef7,color:#c9d1e0
    style RV fill:#1e2d52,stroke:#4f8ef7,color:#c9d1e0
    style M fill:#0f2d1e,stroke:#34c77b,color:#34c77b
```

Every feature moves through the same stages. One `planning/{folder}/` directory ties everything together — `/plan-session` writes the task breakdown, `/dev-task` reads it and appends metrics, `/dev-loop` runs tasks continuously.

## Commands

| Command | Description |
|---------|-------------|
| `/prd {folder}` | Interactive PRD session — qualifying questions, codebase research, and PRODUCT-SPEC.md output ready for /plan-session |
| `/plan-session {repo} {session}` | Structured planning — reads input docs, analyzes codebase, produces a stateful task breakdown. Accepts 1 arg (session) with auto-detected repo as a fallback. |
| `/dev-task {task-id}` | Single task execution — branch, implement, test, simplify, review, PR |
| `/dev-task {task-id} --merge` | Same as above, but auto-merges after review (used by dev-loop) |
| `/dev-loop {folder?}` | Autonomous continuous dev — picks next task, runs dev-task --merge in a loop |
| `/hitl {task-id}` | Execute a human-in-the-loop task — loads task context, assists with infra execution, marks done on exit |
| `/metrics {project?}` | Analyze pipeline metrics — fix cascade trends, quality rates, and recommendations |
| `/refresh-plan {folder}` | Syncs planning doc against current codebase state |
| `/review` | Auto-detecting multi-agent code review for the current branch |
| `/review-staged` | Walk through staged PR reviews conversationally — APPROVEs first, smallest diff first, owner steers each with verbs |
| `/research {task}` | Load relevant project docs and web research for a given task |
| `/research-docs [module|--auto]` | Analyze codebase and generate or update project documentation. `--auto` runs unattended (no prompts) for cron/scheduled use |

### Test Readiness Pipeline

A five-phase pipeline that audits whether a codebase's tests can be trusted by an autonomous agent. Phases 1–4 are read-only on source; Phase 5 publishes to GitHub. Output lands in `docs/test-readiness/` — the same location `/research-docs` digests into `docs/testing.md`.

| Command | Phase | Description |
|---------|-------|-------------|
| `/test-inventory [path]` | 1 | Classify every meaningful code unit and prescribe its canonical test layer (unit/integration/smoke/E2E), ranked by criticality and tagged for canary eligibility |
| `/test-design [path]` | 2 | Design the ideal test system greenfield — frameworks, local substitutes, canary contract, CI shape, coverage targets, speed budgets |
| `/test-migration [path]` | 3 | Reconcile existing tests against the blueprint, bucketing each into reuse / promote / rebuild / trim / net-new |
| `/test-roadmap [path]` | 4 | Synthesize the prior artifacts into a single executable roadmap with five sequenced milestones and an agent-runnable task list |
| `/test-publish [--dry-run] [--yes] [--repo o/n]` | 5 | Publish the roadmap to GitHub as a self-contained issue dashboard with milestones, labels, and a parent tracking issue (`--yes` publishes unattended for the cron) |
| `/test-debt [path]` | post | Compute the corrective-commit ratio per milestone from git history and flag under-specified milestones as planning debt |

Three cross-cutting contracts back the pipeline: **canary-execution** (dual-mode local/`TEST_TARGET_URL` runner), **speed-budgets** (per-layer 95p targets and hard caps), and **repo-config** (branch protection that makes "tests pass" a real gate). `/test-debt` is named to avoid colliding with `/metrics`, which covers shipwright's own dev-pipeline metrics.

## Workflow

```
/prd → /plan-session → /dev-task (or /dev-loop) → /review → merge
```

### 0. PRD

Have an idea but no spec yet? `/prd` turns a rough concept into a structured `PRODUCT-SPEC.md` through an interactive session:

1. Detects toolchain and reads existing project context
2. Asks qualifying questions one at a time: problem statement, users, features (with depth probes per feature), constraints, out-of-scope, priorities, open questions, success criteria
3. Spawns the research agent to surface existing patterns and reuse opportunities
4. Drafts a `PRODUCT-SPEC.md` in the planning folder for review
5. Saves the approved PRD and hands off to `/plan-session`

The output is a properly formatted PRD that `/plan-session` reads directly — features labeled, acceptance criteria in checkbox format, constraints and out-of-scope documented.

### 1. Plan Session

Feed it a folder of requirements docs (PRDs, specs, wireframes). It runs 10 phases to produce a self-contained task breakdown:

| Phase | What Happens |
|-------|-------------|
| 0 | Detect toolchain · check recommended plugins |
| 1–2 | Read all docs in the planning folder · spawn researcher agent to enrich with codebase context |
| 3 | Auto-detect project layers (`src/api/` → API, `src/components/` → Frontend, etc.) · map requirements |
| 4 | Generate granular tasks (1–8h) with IDs, branches, complexity scores (1–5), and pre-answered implementation decisions · run consolidation pass |
| 5–6 | Quality checks (14 verification rules) + user review |
| 7 | Permission pre-flight for env-var prefixed commands |

**Output:** `planning/{folder}/{Project}_Task_Breakdown.md`

Every task includes estimated hours, branch name, layer, dependency chain, complexity score, pre-answered implementation decisions (edge cases, error handling, scope, performance), and acceptance criteria with coverage target.

### 2. Dev Task

```
/dev-task WS-2.1          # Stops at PR for human review
/dev-task WS-2.1 --merge  # Fully automated through merge
```

```mermaid
flowchart TD
    A["1–3  Extract task · check dependencies · detect toolchain"]
    B["4–5  Create feature branch · mark in-progress"]
    C["6–7  Research docs · implement\n        discovery → architecture → code → tests"]
    D["8    Simplify pass  DRY · dead code · naming · complexity"]
    E["9–10 Verify acceptance criteria\n        lint · typecheck · tests · coverage"]
    EE["8.5  Auto-refresh docs  separate docs: refresh commit"]
    F["11   Create PR · CI gate  auto-fix failures"]
    G["12–14 Parallel review agents · auto-fix · squash-merge"]
    H["✓ PR ready"]
    I["✓ Done · planning doc updated"]

    A --> B --> C --> D --> E --> EE --> F
    F -->|standalone| H
    F -->|"--merge"| G --> I

    style H fill:#0f2d1e,stroke:#34c77b,color:#34c77b
    style I fill:#0f2d1e,stroke:#34c77b,color:#34c77b
```

| Mode | Behavior | Best For |
|------|----------|----------|
| Standalone | Pauses after PR creation · presents handoff block with PR link | Tasks that need human review before merging |
| `--merge` | No pause points — all steps unattended | Routine tasks with clear acceptance criteria |

### 3. Dev Loop

Runs `/dev-task --merge` in a continuous loop until all tasks are done or blocked:

1. Pick next task with all dependencies `[x]` (complete)
2. Run `/dev-task --merge` — all steps, fully automated
3. Confirm merged, loop to next task

Pauses only when human judgment is genuinely needed: unmet acceptance criteria, repeated CI failures, blocked dependencies. Offers to roll back pipeline permissions when complete.

### 4. Review

Multi-agent code review that:
- Auto-detects branch and PR context
- Recovers the task ID from the branch name
- Launches parallel agents (code review, silent failure hunting, test analysis, comment review, type design)
- Verifies acceptance criteria against the diff
- Presents a confidence-scored report with structured findings

### 5. Refresh Plan

Updates stale tasks in a planning doc:
- Verifies file paths still exist
- Checks if dependencies have been completed
- Regenerates context fields
- Marks already-met acceptance criteria

### 6. Metrics

```
/metrics                              # all projects, all time
/metrics my-project                   # single project
/metrics --from 2026-03-01            # date filter
/metrics --compare projectA projectB  # side-by-side
```

**The fix cascade** — Shipwright's pipeline has three post-implementation phases that catch and fix issues: Simplify (Step 8), PR Review (Steps 12–14), and CI Gate (Step 11). Each fix is a signal that upstream code generation could be better. `/metrics` measures this rework and tracks it over time.

Key metrics:
- **First-time quality rate** — % of tasks with zero simplify fixes, SHIP IT verdict, and CI pass on first try
- **Simplify fix breakdown** — DRY violations, dead code, naming, complexity, consistency
- **Review verdict distribution** — SHIP IT / NEEDS FIXES / NEEDS WORK
- **CI first-pass rate** and common failure patterns
- **Estimation accuracy** by complexity tier (1–2 / 3 / 4–5)

PostHog events are fired automatically by `/dev-task` at each checkpoint — `/metrics` is pure local analysis.

### 7. Research

- `/research {task}` scans your project's `docs/` directory, selects relevant files, optionally runs web search, and returns distilled context
- `/research-docs [module]` audits your existing documentation, identifies gaps and stale content, and generates or updates docs

Research is also used automatically by `/plan-session` (Phase 2) and `/dev-task` (Step 7a) to load context before planning and implementation.

> **Migration:** If you previously installed the `research` plugin separately, uninstall it after updating shipwright: `/plugin uninstall research`

---

## Planning Folder — Shared State

Every command in the pipeline shares a single `planning/{folder}/` directory:

```
planning/april-2026-workspace-switcher/
├── PRODUCT-SPEC.md                       # Input: requirements doc
├── WorkspaceSwitcher_Task_Breakdown.md   # Written by /plan-session
└── metrics.jsonl                         # Appended by /dev-task after each task
```

```mermaid
flowchart LR
    PS["/plan-session"] -->|writes| TB["Task_Breakdown.md"]
    DT["/dev-task\n/dev-loop"] -->|reads| TB
    DT -->|appends| MJ["metrics.jsonl"]
    MJ -->|read by| MC["/metrics"]
    MJ -->|calibrates estimates| PS
    DT -->|"6 events via\nposthog_send.py"| PH[("PostHog")]
```

---

## PostHog — Automatic Pipeline Telemetry

Set `POSTHOG_PROJECT_API_KEY` as an environment variable. If absent, all PostHog calls are silently skipped — no errors, just no events.

Events fired across the full task lifecycle:

| Event | Fired by | Trigger |
|-------|----------|---------|
| `shipwright_task_started` | `dev-task` | Task marked `in_progress` |
| `shipwright_simplify_complete` | `dev-task` | Simplify pass done |
| `shipwright_pr_created` | `dev-task` | PR created |
| `shipwright_ci_result` | `dev-task` | CI passes or exhausts retries |
| `shipwright_auto_docs` | `dev-task` | Auto-docs refresh complete (Step 8.5) |
| `shipwright_task_blocked` | `dev-task` | Task blocked (requirements, PR failure, CI exhausted) |
| `shipwright_task_approved` | `review` | Review verdict: SHIP IT |
| `shipwright_task_merged` | `review` | PR merged |

Build a funnel from `task_started → pr_created → task_approved → task_merged` to measure cycle time and identify where tasks drop off.

---

## Toolchain Support

Shipwright auto-detects your project's toolchain and adapts all commands accordingly:

| Ecosystem | Detection | Build | Test | Lint |
|-----------|-----------|-------|------|------|
| Node.js | `package.json` + lockfile | from scripts | from scripts | from scripts |
| Rust | `Cargo.toml` | `cargo build` | `cargo test` | `cargo clippy` |
| Go | `go.mod` | `go build ./...` | `go test ./...` | `golangci-lint run` |
| Python | `pyproject.toml` | varies | `pytest` | `ruff check` |
| Ruby | `Gemfile` | — | `rspec` | `rubocop` |
| Make | `Makefile` | `make build` | `make test` | `make lint` |

Multi-ecosystem projects (e.g., Node.js + Rust) are fully supported — validation runs for each detected ecosystem.

Monorepo detection: pnpm workspaces, npm/yarn workspaces, Lerna, Nx, Turborepo, Cargo workspaces, Go workspaces.

## Recommended Plugins

Shipwright is self-contained. It uses Claude Code's built-in `general-purpose` agent type plus the bundled `shipwright:researcher` and `shipwright:code-reviewer` agents — no other plugins are required. These optional integrations add extra capability:

| Plugin | Source | Used By | What It Enables |
|--------|--------|---------|-----------------|
| `frontend-design` | [Claude Code plugins](https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design) | `/dev-task` | When a task is tagged with `Design Skill: frontend-design` in the planning doc, produces distinctive, high-quality UI instead of generic AI-generated interfaces |
| `posthog` (optional) | [PostHog plugin](https://github.com/PostHog/posthog-mcp) | `/metrics` | Enables querying PostHog pipeline data via MCP. Only needs `POSTHOG_PROJECT_API_KEY` env var for event sending — the MCP server is optional for querying |

### What Happens Without Them

| Plugin | Without It | With It |
|--------|-----------|---------|
| `frontend-design` | UI tasks are implemented using standard code generation following existing codebase patterns. | UI tasks tagged with Design Skill get a dedicated design pass that produces polished, distinctive interfaces. |

### Installation

```
/plugin install frontend-design
```

## Configuration

### Coverage Threshold

Default: 90%. Set during `/plan-session` and stored in the planning doc's Project Metadata section.

### Planning Doc Location

All commands look for planning docs at `planning/**/*_Task_Breakdown.md`. Create your planning folder under `planning/` before running `/plan-session`.

### Permissions

`/plan-session` Phase 7 auto-detects env-var prefixed commands that won't auto-approve, and presents patterns to add to `.claude/settings.local.json`. After `/dev-loop` completes, it offers to roll back pipeline-specific permissions.

## Task Store

Shipwright uses an HTTP task store service for task persistence. The service exposes a REST API; agents call it directly via curl.

**Required env vars** (provisioned automatically by the agent harness):

| Var | Description |
|-----|-------------|
| `SHIPWRIGHT_TASK_STORE_URL` | Base URL of the task store service |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | Bearer token for this agent |

See the `task-store` skill for the full API reference and lifecycle commands.

---

## Architecture

```
shipwright/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest
├── agents/
│   ├── researcher.md            # Research sub-agent (sonnet)
│   ├── code-reviewer.md         # Multi-angle code review sub-agent
│   └── docs-refresher.md        # Targeted docs refresh sub-agent (used by /dev-task Step 8.5)
├── commands/
│   ├── prd.md                   # Interactive PRD session → PRODUCT-SPEC.md
│   ├── plan-session.md          # Planning session workflow
│   ├── dev-task.md              # Single task execution
│   ├── dev-loop.md              # Autonomous continuous loop
│   ├── metrics.md               # Pipeline metrics analysis
│   ├── refresh-plan.md          # Planning doc refresh
│   ├── research.md              # Load project docs and web research
│   ├── research-docs.md         # Generate/update project documentation
│   └── review.md                # Multi-agent code review
├── skills/
│   ├── agent-admin/
│   │   └── SKILL.md             # Manage Shipwright agents — crons, env vars, tools, tokens, plugins
│   ├── review-staged/
│   │   └── SKILL.md             # Conversational walkthrough of staged reviews
│   └── task-store/
│       └── SKILL.md             # Query and update the task store — lifecycle invocations, env var config
├── references/
│   ├── doc-refresh-recipe.md    # Shared staleness + section-rewrite recipe (research-docs + docs-refresher)
│   ├── metrics-schema.md        # Metrics JSONL schema reference
│   ├── planning-doc-template.md # Task breakdown document template
│   ├── product-spec-template.md # PRODUCT-SPEC.md template for /prd
│   └── toolchain-patterns.md    # Config file → command mapping
├── scripts/
│   └── posthog_send.py          # PostHog event sender (stdlib Python, no deps)
├── README.md
└── TESTING.md
```

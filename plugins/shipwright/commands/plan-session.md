---
description: Engineer planning pass — reads the product spec, explores the codebase, flags complexity, and produces a task queue
arguments:
  - name: repo
    description: The repo to plan work for (e.g., shipwright)
    required: true
  - name: session
    description: A short slug for this planning session (e.g., may-billing-refactor). Used to group tasks and PRs.
    required: true
---

# Plan Session: $ARGUMENTS

Parse `$ARGUMENTS` to extract:
- **repo**: first argument
- **session**: second argument

**If only one argument is provided**, treat it as `session` and auto-detect `repo`:
1. `git remote get-url origin` → parse owner/repo, strip trailing `.git`. Use the bare repo name.
2. Fallback: `basename $(git rev-parse --show-toplevel)`

Then print:
```
⚠ Auto-detected repo: {repo}
This will be written to every task in state/todos.json and used by /dev-task to
locate the source tree (~/src/{repo}). Confirm it is correct before proceeding.
```
Wait for user confirmation before continuing to Step 1.

This is the engineering planning pass. The product spec (what and why) is already done — either from `/brainstorm` or handed in directly. This session translates that spec into a concrete technical design and task queue.

**Input:** `planning/{session}/PRODUCT-SPEC.md` (or a verbal description if no spec exists)
**Output:** Tasks in `state/todos.json`, ready for `dev-task` to execute

---

## Phase-0: Backend Setup (GitHub only)

Detect the active backend and, when it is `"github"`, run the task store setup before any context loading:

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
PHASE0_BACKEND=$([ -n "$PLUGIN_SCRIPTS" ] && bun "$PLUGIN_SCRIPTS/task_store.ts" backend 2>/dev/null)
PHASE0_BACKEND=${PHASE0_BACKEND:-json}
[ "$PHASE0_BACKEND" = "github" ] && bun "$PLUGIN_SCRIPTS/task_store.ts" setup
```

If the `setup` command exits non-zero, print the error and **stop** — a misconfigured board means
tasks written in Step 6 won't land on the board and the queue will be out of sync.

If the active backend is `"json"` (the default), skip this step.

---

## Step 1: Load Context

1. Read `CLAUDE.md` in the repo worktree if available, otherwise read from `~/src/{repo}/`
2. Glob the repo structure to understand the codebase layout
3. Check for any existing tasks in this session to avoid duplicates:
   ```bash
   PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
   [ -n "$PLUGIN_SCRIPTS" ] && bun "$PLUGIN_SCRIPTS/task_store.ts" query --session {session}
   ```
   The output is a JSON array. If non-empty, print the existing task IDs and skip re-adding them.
4. Read `planning/{session}/PRODUCT-SPEC.md` if it exists — this is the primary input

Present a brief orientation:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAN SESSION: {session}
Repo: {repo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Spec: {found / not found}
{If found: 1-2 sentences summarizing what's being built}
{If not found: "No PRODUCT-SPEC.md found — I'll ask for a description."}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If no spec exists, ask: **"What are we building?"** and collect enough to proceed. Keep it brief — this is an engineering session, not a discovery session.

---

## Step 2: Explore the Codebase

**Load test layer definitions first.** Before mapping the spec to source code, check whether `docs/test-readiness/test-system.md` exists in the repo worktree. If it exists, read it and extract the layer definitions (unit, integration, smoke, e2e) — you will use these in Step 4 and when writing acceptance criteria in Step 5. If the file is absent, use these defaults:

- **unit** — isolated logic: no I/O, no DB, no network; pure function or class in memory
- **integration** — real external dependencies: real DB (Docker), recorded fixture clients for external HTTP; inject test doubles via DI — never `mock.module()` or `global.fetch`
- **smoke** — critical-path HTTP flows exercised via Hono's in-process `app.request()` driver; no real socket
- **e2e** — full user journeys in a real browser (Playwright); real HTTP, multi-step flows

Map the spec to the codebase across four layers. For each layer that the spec touches:

**Business logic** — find where the relevant rules/behaviors currently live; identify what's new vs. what's changing
**Views/UX** — find the affected components or pages; understand the current rendering patterns
**APIs** — find the relevant endpoints and their handlers; note request/response shapes that will change
**DB** — find the schema files and any existing migrations; understand the current data model

For each layer:
1. Read the files most likely affected
2. Look for existing patterns to reuse (functions, types, abstractions)
3. Identify what's NEW vs what's a MODIFICATION

**Flag complexity risks as you go** — call these out before proposing a design:
- Tightly coupled code that's hard to extend without broader refactoring
- Missing abstractions that would need to be built first
- Features that look simple in the spec but are disproportionately complex in the code
- Cross-layer dependencies that constrain the order of implementation
- Anything in the spec that would introduce unjustified complexity — surface it and suggest a simpler alternative

Example flags:
- "⚠ This touches the auth middleware which is shared across all routes — higher risk than it appears"
- "⚠ The spec adds X to the billing API but the billing service has no test coverage — any change here is risky without tests first"
- "⚠ This feature requires a new abstraction that doesn't exist yet — adds ~2h of foundational work before the feature itself"

**Breaking Change Scan** — additions are safe to deploy at any time; renames and removals are not. For any rename or removal in the spec, grep for all current callers before proposing tasks:

- **DB**: dropping or renaming a table or column — who reads or writes it?
- **API**: removing or renaming an endpoint or response field — who calls it?
- **Client/types**: removing or renaming a method or interface — who imports it?

List every consumer found. A task that drops the old interface while leaving consumers on the old code creates a broken intermediate state that cannot be deployed safely.

Additions (new tables, nullable columns, new endpoints, new optional fields, new methods) are safe. Flag only renames and removals.

---

## Step 3: Research (if needed)

If the implementation approach isn't clear from the codebase, do a web search:
- What are the common approaches to this problem?
- Are there libraries that handle this, or is custom code the right call?

Bias toward the simplest solution that fits existing patterns. Summarize findings before moving to design.

---

## Step 4: Propose a Design

Present a concrete technical design organized by layer:

**Business logic** — what rules/behaviors are added or changed and where they live in the code
**Views/UX** — what components or pages change and how
**APIs** — what endpoints change, what request/response shapes look like
**DB** — schema changes, migration approach

Also include:
- Specific files that will change
- How it integrates with existing patterns
- Any complexity risks from Step 2 and how the design addresses (or explicitly accepts) them
- **Per-layer test reasoning** — for each module touched by the spec, state: which layer owns its coverage (unit / integration / smoke / e2e), what justifies a test at that scope rather than a narrower one, and which existing tests become redundant or should be retired as a result of the change. Use the layer definitions loaded in Step 2.

Keep it simple. If two approaches exist, recommend one and explain why.

Iterate on feedback. Do not move to task breakdown until the design is approved.

---

## Step 5: Task Breakdown

Break the approved design into tasks. Each task should be independently shippable (its own PR) unless they are explicitly bundled (see Bundles below).

For each task:
- **ID**: `{PREFIX}-{N}.{M}` — prefix is 2-3 letters from the feature name
- **Title**: short, verb-first (e.g., "Add billing schema migration")
- **Description**: what to build, not how
- **Acceptance Criteria**: 2-5 bullet points — specific, testable. Every task **must** include at least one test decision bullet that names: (a) which test layers are affected, (b) what tests are added (layer + scenario, e.g., "add integration test for X"), and (c) what existing tests are retired and why (be specific — "remove mocked unit test Y because real integration test now covers this path", not just "update tests"). If no test change is needed, state that explicitly and justify it.
- **Dependencies**: which tasks must complete before this task is ready (task IDs or empty)
- **Branch**: `feat/{id-lowered-dashes}-{first-3-words-kebab}` — or a shared branch name for bundled tasks (see below)
- **Layer**: API | Frontend | Database | Shared | Background | CLI
- **Hours**: rough estimate (1-8h; break tasks larger than 8h)
- **HITL**: `⚠ HITL` if the task requires human action (see Step 5.5); omit otherwise
- **Complexity**: integer 1–5 — use the scoring table below
- **Model**: `haiku` | `sonnet` | `opus` — derived from complexity score (see table)

### Complexity and Model Scoring

Assign a complexity score (1–5) and model tier to every task:

| Score | Signal | Model |
|-------|--------|-------|
| 1 | Single file, config/copy change, no logic, unit tests only | `haiku` |
| 2 | 1–2 files, straightforward logic, unit tests only | `haiku` |
| 3 | 2–5 files, standard feature, integration tests | `sonnet` |
| 4 | 5+ files, cross-layer, new patterns, integration + smoke tests | `sonnet` |
| 5 | Architectural, cross-layer, new abstraction, migration, or perf-sensitive | `opus` |

**Tie-breaking rules:**
- New abstraction required (interface, base class, shared module) → bump up one tier
- Pure modification of existing code (no new patterns) → stay at current tier
- When uncertain, prefer the lower tier — the planner can escalate in a follow-up plan revision if execution is blocked

**Bundle inheritance:** When tasks share a branch, all tasks in the bundle inherit the highest model tier among them. A haiku-tier task bundled with a sonnet-tier task runs at sonnet.

### Bundles

Tasks that are tightly coupled — where splitting into separate PRs would produce unreviable intermediate states or create unnecessary ceremony — can share a branch. Assign them the same `branch` value to co-locate them in one PR.

**When to bundle:** Changes across adjacent layers (e.g., DB migration + API + frontend for a single feature) where the reviewer needs all three in context, or tasks where sequential separate PRs would take longer than the coupling overhead.

**Dependency semantics for bundles:** A downstream task that lists an upstream bundle-mate as a dependency only requires it to reach `pr_open` (code on the branch) — not `merged`. This allows the execution cron to queue bundle-mates sequentially on the same PR without waiting for a merge gate.

**Branch naming for bundles:** Use a shared branch that describes the whole bundle, not one task: `feat/{prefix}-{short-feature-slug}` (e.g., `feat/iq-db-api-frontend`).

### Dependency Map

Present the map in two forms:

**1. Visual graph:**
```
[START]
  ├─ {PREFIX}-1.1: {title} (no deps)
  └─ {PREFIX}-1.2: {title} (no deps)
        └─ {PREFIX}-2.1: {title} (needs 1.1, 1.2)
              └─ {PREFIX}-2.2: {title} (needs 2.1)
```

**2. Summary table:**
```
Task         | Depends on  | Blocks | HITL
{PREFIX}-1.1 | —           | 2.1    |
{PREFIX}-1.2 | —           | 2.1    |
{PREFIX}-2.1 | 1.1, 1.2    | 2.2    | ⚠ HITL
{PREFIX}-2.2 | 2.1         | —      |
```

### Breaking Change Safety

Before finalizing the task list, check each task for renames or removals flagged in Step 2. For each one, the task must do one of:

1. **Atomic update** — include all consumer updates in the same task. One PR removes the old thing and updates every caller.
2. **Add → migrate → remove** — split into three sequential tasks: (a) add the new thing alongside the old, (b) migrate all consumers to the new, (c) remove the old.

A task that drops or renames something while a later task updates the consumers is not safe to deploy independently — that gap is a broken intermediate state in production.

If a task has no renames or removals, mark it: `Safe to deploy standalone: yes`.

Present the task list and dependency map as a first pass. The engineer reviews and iterates — they may catch implementation details, missing edge cases, or better task splits. Iterate until approved.

---

## Step 5.5: HITL Detection

Before writing tasks to the queue, scan every task for Human-in-the-Loop requirements. A task is HITL if it cannot be completed autonomously — it requires a human to act in a UI, provision a credential, or execute a privileged command outside the automated pipeline.

### Keyword Heuristics

Flag a task as HITL if its title or description contains any of the following keywords (case-insensitive):

```
terraform, helm, kubectl, GKE, GCP, deploy (image/cluster context),
container registry, image push, certificate, Cloud SQL, kube-context,
rollout, helm upgrade, kubectl apply, PAT, personal access token,
provision secret, GitHub settings, branch protection, allow_auto_merge
```

### Judgment Step

Even without a keyword match, flag the task HITL if it fundamentally requires:
- A human to act in a web UI (e.g., GCP Console, GitHub Settings, DNS registrar, cloud provider dashboard)
- Provisioning or rotating a credential, secret, or API key
- Approving a privileged workflow that requires human authorization
- Any action that cannot be expressed as a CLI command the agent can run

Apply judgment: if the task description implies "someone must click approve in the console" or "create a secret in 1Password," it's HITL regardless of the keywords present.

### How to Flag a Matched Task

For each task that matches either heuristic:

1. **Set `hitl: true`** in its task JSON (see Step 6 templates)
2. **Inject a `## Human steps` section** into its description naming:
   - What access is required (e.g., "Requires: GCP Console IAM editor role")
   - Suggested command or action (e.g., `gcloud secrets versions add my-secret --data-file=- <<< "value"`)
   - Any pre-requisite setup (e.g., "Must have kube-context set to production cluster")
3. **Mark the task `⚠ HITL`** in the task table (HITL column)

Non-matching tasks are unaffected — do not add a `## Human steps` section or set `hitl: true` on them.

**Example HITL description injection:**
```
{original description}

## Human steps
Requires: GCP Console access (Cloud SQL Admin role)
Action: Set the database password via Cloud SQL Studio or:
  gcloud sql users set-password app --instance=prod-db --password=<value>
Pre-requisite: Ensure kube-context is pointed at the production cluster before running migrations.
```

After scanning, list any flagged tasks:
```
HITL tasks detected: {count}
{PREFIX}-X.Y — {title} — flagged by: {keyword match / judgment}
```

If no tasks are flagged, print:
```
HITL scan: no tasks require human steps
```

---

## Step 6: Write to Queue

Once the task breakdown is approved, write each task to the task store via `task_store.ts`.

### Bundle Model Inheritance (Pre-Write)

Before constructing any JSON, apply bundle inheritance to the full task list:

1. Group planned tasks by `branch`.
2. For each group with more than one task (a bundle), find the highest model tier present: `opus` > `sonnet` > `haiku`.
3. Set every task in that bundle to the highest tier before writing.

A task on its own branch is unaffected. This ensures a `haiku`-scored task bundled with a `sonnet`-scored task is written as `model: "sonnet"`.

The code path depends on `taskStore` in `SHIPWRIGHT_CONFIG`. Read it the same way Phase-0 does:

```bash
SHIPWRIGHT_CONFIG_VALUE=$(bun "$PLUGIN_SCRIPTS/task_store.ts" backend 2>/dev/null || echo "json")
```

**Branch gate — choose exactly one path based on `SHIPWRIGHT_CONFIG_VALUE`:**

- If `SHIPWRIGHT_CONFIG_VALUE` == `"github"` → follow **Path B** (GitHub Issues) below.
- Otherwise (value is `"json"` or empty) → follow **Path A** (local JSON) below.

Do not execute both paths. Skip the path that does not apply.

---

### Path A: taskStore is "json" (default)

Write the new tasks to a temp file `/tmp/new-tasks-{session}.json` as a JSON array:

```json
[
  {
    "id": "{PREFIX}-{N}.{M}",
    "source": "shipwright",
    "session": "{session}",
    "repo": "{repo}",
    "title": "...",
    "description": "...",
    "acceptanceCriteria": ["...", "..."],
    "layer": "API | Frontend | Database | Shared | Background | CLI",
    "branch": "feat/...",
    "dependencies": [],
    "status": "pending",
    "hitl": false,
    "pr": null,
    "addedAt": "{ISO timestamp}",
    "hours": 2,
    "complexity": {complexity},
    "model": "{model}"
  }
]
```

Set `"hitl": true` (and include the `## Human steps` section in `description`) for any task flagged in Step 5.5.

Append them to `state/todos.json` via task_store.ts (idempotent by id — safe to re-run):

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" append --file /tmp/new-tasks-{session}.json
```

---

### Path B: taskStore is "github"

**Step 6a — Read owner/repo from config:**

```bash
SHIPWRIGHT_REPO_FULL=$(bun "$PLUGIN_SCRIPTS/task_store.ts" repos 2>/dev/null | head -1)
[ -z "$SHIPWRIGHT_REPO_FULL" ] && { echo 'ERROR: repos returned no output — ensure github.owner and github.repo are set in .shipwright.json' >&2; false; }
SHIPWRIGHT_OWNER=$(echo "$SHIPWRIGHT_REPO_FULL" | cut -d'/' -f1)
SHIPWRIGHT_REPO=$(echo "$SHIPWRIGHT_REPO_FULL" | cut -d'/' -f2)
```

If `SHIPWRIGHT_REPO_FULL` is empty (i.e. `repos` returned no output), stop immediately. Ensure `github.owner` and `github.repo` are configured in the active task store config before retrying.

**Step 6b — Create a parent GitHub Issue for the plan:**

The parent issue body is the full plan markdown from Steps 4 and 5: the session name, technical design, and task table. Because the body contains newlines, backticks, and double-quotes, it must be written to a temp file first — passing it inline via `--body "..."` will break.

Write the plan body to a temp file, then create the issue using `--body-file`:

```bash
# Write the full plan markdown to a temp file
cat > /tmp/plan-body.md << 'PLANEOF'
{full plan markdown — session name, technical design summary, and task table from Steps 4–5}
PLANEOF

# Create the parent issue using --body-file to safely handle newlines, quotes, and backticks
PARENT_ISSUE_URL=$(gh issue create \
  --repo "$SHIPWRIGHT_OWNER/$SHIPWRIGHT_REPO" \
  --title "[plan] {session}" \
  --body-file /tmp/plan-body.md)

# Extract the issue number from the URL (e.g. https://github.com/owner/repo/issues/42 → 42)
PARENT_ISSUE_NUMBER=$(echo "$PARENT_ISSUE_URL" | grep -o '[0-9]*$')

# Create session label (idempotent) and apply to parent plan issue
gh label create "session:{session}" --color 0075CA --force \
  --repo "$SHIPWRIGHT_OWNER/$SHIPWRIGHT_REPO"
gh issue edit "$PARENT_ISSUE_NUMBER" \
  --repo "$SHIPWRIGHT_OWNER/$SHIPWRIGHT_REPO" \
  --add-label "session:{session}"
```

If `PARENT_ISSUE_URL` is empty after the `gh issue create` call, stop immediately — do not write tasks. Print:

```
✗ Failed to create parent plan issue — cannot proceed. Check repo permissions and try again.
```

If `PARENT_ISSUE_NUMBER` is empty (URL was returned but the number could not be parsed), stop immediately — do not write tasks. Print:

```
✗ Could not extract issue number from URL: {PARENT_ISSUE_URL} — cannot proceed.
```

The content between `PLANEOF` markers should be the verbatim markdown you produced in Steps 4 and 5 — the design section and the full task table.

**Step 6c — Write tasks with source referencing the parent issue:**

Write the tasks to `/tmp/new-tasks-{session}.json`. Set `source` to `"gh:{owner}/{repo}#{parent_number}"` on every task — this links each child task issue back to the parent plan issue:

```json
[
  {
    "id": "{PREFIX}-{N}.{M}",
    "source": "gh:{owner}/{repo}#{parent_issue_number}",
    "session": "{session}",
    "repo": "{repo}",
    "title": "...",
    "description": "...",
    "acceptanceCriteria": ["...", "..."],
    "layer": "API | Frontend | Database | Shared | Background | CLI",
    "branch": "feat/...",
    "dependencies": [],
    "status": "pending",
    "hitl": false,
    "pr": null,
    "addedAt": "{ISO timestamp}",
    "hours": 2,
    "complexity": {complexity},
    "model": "{model}"
  }
]
```

Set `"hitl": true` (and include the `## Human steps` section in `description`) for any task flagged in Step 5.5.

To inject the source field into an already-assembled tasks array using `jq`:

```bash
PARENT_REF="gh:$SHIPWRIGHT_OWNER/$SHIPWRIGHT_REPO#$PARENT_ISSUE_NUMBER"
jq --arg src "$PARENT_REF" \
  'map(. + {"source": $src})' \
  /tmp/new-tasks-{session}.json > /tmp/new-tasks-{session}-linked.json
```

**Step 6d — Append tasks to the store:**

```bash
PLUGIN_SCRIPTS=$(find ~/.claude/plugins/cache -maxdepth 5 -name "task_store.ts" -path "*/shipwright/*" 2>/dev/null | sort -V | tail -1 | xargs dirname 2>/dev/null)
bun "$PLUGIN_SCRIPTS/task_store.ts" append --file /tmp/new-tasks-{session}-linked.json
```

This creates individual GitHub Issues for each task with the `status:pending` label, and the `source` field in each issue's metadata block links back to the parent plan issue.

---

Confirm with:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session: {session}
Tasks queued: {count}
{If github: Parent issue: https://github.com/{owner}/{repo}/issues/{parent_number}}

READY TO START (no dependencies):
{list tasks with no deps}

BLOCKED (waiting on deps):
{list tasks with deps → what they're waiting on}

The execution cron will pick up ready tasks automatically.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---
description: Engineer planning pass — reads the product spec, explores the codebase, flags complexity, and produces a task queue
arguments:
  - name: repo
    description: The repo to plan work for, in org/repo format (e.g., app-vitals/shipwright)
    required: true
  - name: session
    description: A short slug for this planning session (e.g., may-billing-refactor). Used to group tasks and PRs.
    required: true
---

# Plan Session: $ARGUMENTS

> **Task store setup:** This command appends planned tasks to the Shipwright task store. If `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke `/shipwright:task-store` for setup instructions.

Parse `$ARGUMENTS` to extract:
- **repo**: first argument
- **session**: second argument
- **`--autonomous {task-id}`** (optional): the id of the originating PRD task in the task store — the one recorded as `kind: "prd"`. `{task-id}` is used by Step 4 and Step 5 for the hard-contradiction PATCH-to-blocked escape hatch, and by Step 6 for the on-success PATCH-to-done. **When `--autonomous` is present, `repo` and `session` are always passed explicitly by the machine dispatcher invoking this mode** — the single-argument auto-detect-and-confirm flow below does not apply and must not run in this mode.
- _(no arguments)_: respond `[silent]` and stop immediately — no repo auto-detect, no
  task-store queries, no planning work. This command always targets one explicitly-named
  planning session; it never self-selects work.

**If `$ARGUMENTS` is empty, respond `[silent]` and stop** — do not run `git remote get-url origin`,
do not print the auto-detect warning, do not wait for confirmation. A `session` slug is required
and cannot be inferred, so there is nothing to plan. This matches the no-target behavior of the
other loop-driven pipeline commands (`dev-task`, `review`, `patch`, `deploy`) and is what makes a
standalone `shipwright-plan` cron (whose stored prompt is a bare `/shipwright:plan-session` with
no target, dispatched only when `shipwright-loop` is disabled) silently inert rather than kicking
off an untargeted planning session against whatever repo the working directory happens to be.
The single-argument auto-detect-and-confirm flow below applies only when a `session` slug **is**
supplied.

**If only one argument is provided** (and `--autonomous` was not passed), treat it as `session` and auto-detect `repo`:
1. `git remote get-url origin` → parse the `org/repo` value, stripping trailing `.git`. Preserve the full owner/repo value — do not strip it down to just the repo segment. This is the `repo` value used for the task-store `repo` field.
2. Fallback (only when the remote parse fails): `basename $(git rev-parse --show-toplevel)`. In this fallback case there is no owner segment, so `repo` and `repo-slug` end up the same bare value.
3. Derive `repo-slug` from `repo`: the last path segment, lowercased — e.g. `app-vitals/shipwright` → `shipwright`. Use `repo-slug` for all local filesystem path references.

Then print:
```
⚠ Auto-detected repo: {repo}
This will be written to every task in the task store and used by /dev-task to
locate the source tree (${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}). Confirm it is correct before proceeding.
```
Wait for user confirmation before continuing to Step 1.

This is the engineering planning pass. The product spec (what and why) is already done — either from `/prd` or handed in directly. This session translates that spec into a concrete technical design and task queue.

**Input:** `planning/{session}/PRODUCT-SPEC.md` (or a verbal description if no spec exists; under `--autonomous`, the originating task's `description` is materialized to that path — see Step 1)
**Output:** Tasks in the task store, ready for `dev-task` to execute

---

## Step 1: Load Context

1. Read `CLAUDE.md` in the repo worktree if available, otherwise read from `${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}/`
2. Glob the repo structure to understand the codebase layout
3. Check for any existing tasks in this session to avoid duplicates. Under `--autonomous {task-id}`, set `AUTONOMOUS_TASK_ID` to `{task-id}` first; otherwise leave it unset and the filter is a no-op:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" "$SHIPWRIGHT_TASK_STORE_URL/tasks?session=$SESSION" \
     | jq --arg t "${AUTONOMOUS_TASK_ID:-}" '.tasks | map(select(.id != $t))'
   ```
   The response is a paginated envelope — unwrap `.tasks` to get the array. The `select(.id != $t)` drops the originating PRD task in autonomous mode: it shares this session slug because it is the session's *input*, not a duplicate of the work it produces. If the result is non-empty, print the existing task IDs and skip re-adding them.
4. Scan for open tasks from prior sessions that may be prerequisites for this work:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks?state=open" | jq --arg s "$SESSION" \
     '.tasks // [] | map(select(.session != $s)) | unique_by(.id)'
   ```
   If the result is non-empty, print a brief summary before the orientation header:
   ```
   ⚠ Open cross-session tasks ({count}):
   {ID} [{status}] — {title}  (session: {session_slug})
   ...
   Keep these in mind when designing the dependency map in Step 5 — new tasks may depend on them.
   ```
   If empty, continue silently. These IDs are valid `dependencies` values in Step 5.
5. Read `planning/{session}/PRODUCT-SPEC.md` if it exists — this is the primary input

### `--autonomous` Mode

When `--autonomous {task-id}` was passed, the spec arrives through the originating task record, not through a human. Run this between 1.5 and the orientation header:

1. If `planning/{session}/PRODUCT-SPEC.md` already exists in the worktree, use it as-is and continue to the orientation header.
2. If the file does not exist, fetch the originating PRD task and materialize the spec from its `description`:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" | jq -r '.description // ""'
   ```
   Submitters (e.g. an external `submit-prd` gateway) prefix the spec with the instruction line `Commit as PRODUCT-SPEC.md and run /shipwright:plan-session.` — strip that line and any blank lines that follow it. Write what remains to `planning/{session}/PRODUCT-SPEC.md` (create the directory if needed). From here on it is the primary input for Steps 2–5, exactly as if `/prd` had written it.
3. If the description is missing, or blank after stripping, there is nothing to plan and no human to ask. Block the task and stop:
   ```bash
   curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
     -d '{"status": "blocked", "hitl": true, "blockedReason": "plan_session_autonomous_no_spec: no planning/{session}/PRODUCT-SPEC.md in the worktree and the task description is empty"}' | jq .
   ```
   Print `⚠ Task {task-id} has no spec to plan from — blocked for human triage (plan_session_autonomous_no_spec).` and stop. Do not continue to Step 2.

The interactive fallback below — asking **"What are we building?"** — must never run under `--autonomous`; there is no one to answer it. (The originating task `{task-id}` is already excluded from 1.3's duplicate scan by that step's own `select(.id != $t)` filter — no further action here.)

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

If no spec exists (and `--autonomous` was not passed — see the `--autonomous` Mode subsection above), ask: **"What are we building?"** and collect enough to proceed. Keep it brief — this is an engineering session, not a discovery session.

### Resolve the configured plan-session subagent (PSM-1.2)

Runs once here, after the spec is loaded. Fetches the agent's configured phase-methodology
override for the plan-session phase (PMC-1.1) off the same `GET /agents/{id}/config` endpoint
`review.md`'s Step 4 and `patch.md`'s Step 1 already use — same endpoint, same auth header,
just a different field. Best-effort and fail-soft: any failure here is never a hard stop.

```bash
PLAN_SESSION_SUBAGENT_TYPE=$(curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq -r '.phaseMethodology["plan-session"] // empty')
```

**Fail-soft to the built-in path, not fail-open to an unvalidated dispatch.** When
`.phaseMethodology["plan-session"]` is absent or `null` (the jq `// empty` default), or the
curl fails outright, `PLAN_SESSION_SUBAGENT_TYPE` is empty and **Steps 2 through 5.5 run
unchanged, exactly as they do today** — same codebase exploration, same design loop, same
task breakdown, same HITL scan. An empty value never means "dispatch something else"; it
means "run the built-in decomposition."

**There is no built-in `subagent_type` fallback name here.** Unlike `review.md`, whose
built-in default (`shipwright:code-reviewer`) is itself a dispatchable subagent, this
command's built-in decomposition is not itself a dispatchable subagent — Steps 2 through 5.5
are a multi-step flow the main agent thread runs inline in this session (reading code,
proposing designs, iterating with a human or applying autonomous defaults). So the empty
value is the built-in path, not a name to dispatch.

**When `PLAN_SESSION_SUBAGENT_TYPE` is non-empty**, skip Steps 2 through 5.5 entirely and
jump to the **Configured Methodology Dispatch (PSM-1.2)** section that follows Step 5.5, then
continue to Step 6 from there.

---

## Step 2: Explore the Codebase

**Load test layer definitions first.** Before mapping the spec to source code, check whether `docs/test-readiness/test-system.md` exists in the repo worktree. If it exists, read it and extract the layer definitions (unit, integration, smoke, e2e) — you will use these in Step 4 and when writing acceptance criteria in Step 5. If the file is absent, use these defaults:

- **unit** — isolated logic: no I/O, no DB, no network; pure function or class in memory
- **integration** — real external dependencies: real DB (Docker), recorded fixture clients for external HTTP; inject test doubles via DI — never `mock.module()` or `global.fetch`
- **smoke** — critical-path HTTP flows exercised via Hono's in-process `app.request()` driver; no real socket
- **e2e** — full user journeys in a real browser (Playwright); real HTTP, multi-step flows

If the spec has a Source Map (per-feature list of existing files each feature touches), seed file exploration from it — read those files first before globbing broadly. This avoids re-deriving what the PRD session already identified. If a feature's Source Map is absent or empty, fall back to the full glob-and-search approach below.

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

**Data-backfill migrations need a live-data check, not just a design review.** If a task involves a migration that assigns or attributes existing rows by pattern-matching a column (mapping an existing value to a new one), flag that the task's acceptance criteria must require querying the live table for its actual distinct values and confirming every distinct group is covered — not just checking the mapping against docs/config/API references. Test fixtures for that migration must be seeded from the same live-distinct-values check. A mapping that looks complete against documentation can still miss a real data shape that only a live query would surface.

This is likely **HITL** — see the conditional judgment step in Step 5.5.

**Breaking Change Scan** — additions are safe to deploy at any time; renames and removals are not. For any rename or removal in the spec, grep for all current callers before proposing tasks; for a constraint addition (see below), verify backfill completeness against live data instead:

- **DB**: dropping or renaming a table or column — who reads or writes it?
- **DB**: adding a `NOT NULL`, foreign key, or other constraint to a column on a table that already has rows — has the existing data been backfilled to satisfy it? Adding the constraint before the backfill is complete will fail on (or corrupt) existing rows.
- **API**: removing or renaming an endpoint or response field — who calls it?
- **Client/types**: removing or renaming a method or interface — who imports it?
- **Release/deployment pipeline**: the pipeline itself is an interface with external consumers. Changes to how artifacts are built, packaged, or published; where they land; what events or signals are emitted during the process; or what triggers downstream workflows — any of these can silently break systems in other repos that depend on the current behavior. Those consumers won't appear in a local grep and won't error loudly; they'll just stop running. Before designing any task that modifies the build, release, or deploy pipeline, identify what depends on its current behavior and how the change affects each dependency.

List every consumer found. A task that drops the old interface while leaving consumers on the old code creates a broken intermediate state that cannot be deployed safely.

Additions (new tables, nullable columns, new endpoints, new optional fields, new methods) are safe. Flag only renames, removals, and substitutions that change behavior — and constraint additions (`NOT NULL`, foreign key, unique) on a column with existing rows, which behave like a breaking change even though they read like an addition.

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
- **Per-layer test reasoning** — if the spec has a Testing Strategy section, adopt it directly rather than re-deriving: confirm the layer assignments make sense given the codebase findings in Step 2, note any disagreements, and proceed with the spec's strategy unless a concrete technical reason overrides it. If Testing Strategy is absent, derive it from scratch using the layer definitions loaded in Step 2.

Keep it simple. If two approaches exist, recommend one and explain why.
If the spec is ambiguous or silent on a decision that affects the design, state the assumption you're making and flag it explicitly for confirmation during this feedback loop — don't pick an interpretation silently.

Iterate on feedback. Do not move to task breakdown until the design is approved.

### `--autonomous` Mode

When `--autonomous {task-id}` was passed, this replaces the iterate-until-approved loop above with accept-first-pass: a flagged PRD is already trusted/complete — not a first-draft ambiguous spec — so there is no human in this loop to iterate with.

Apply a loose ambiguity bar with exactly two cases:

- **Soft ambiguity** — the spec is silent, vague, or offers multiple reasonable readings on a design decision, but a sensible default exists. Apply the default. Do not stall or ask a clarifying question — log it (see Decision Log below) instead of flagging for human confirmation.
- **Hard contradiction** — the spec's own requirements conflict with each other, or with a hard codebase constraint, in a way no default can resolve without guessing. Do NOT fabricate an answer or silently pick a side. Stop immediately:
  ```bash
  curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
    -d '{"status": "blocked", "hitl": true, "blockedReason": "plan_session_autonomous_hard_contradiction: {one-line description}"}' | jq .
  ```
  Then stop the command entirely — do not proceed to Step 5.

**Decision Log:** every default applied under the loose ambiguity bar above is recorded as a bullet under a `## Decision Log` section appended to the design writeup, in the form `- {decision point}: defaulted to {choice} — {one-line reason}`. This log carries through into `planning/{session}/PLAN.md` when Step 6a writes the plan to disk — this is what satisfies "every auto-approval decision recorded in the PLAN.md artifact."

---

## Step 5: Task Breakdown

Break the approved design into tasks. Each task should be independently shippable (its own PR) unless they are explicitly bundled (see Bundles below).

Before writing tasks, load the principles file:

1. Check for a project-level override: `.claude/shipwright/principles.md` in the project root.
2. If it exists, load it and print: "Using project config: `.claude/shipwright/principles.md`"
3. If it does not exist, load the default: `plugins/shipwright/references/principles.md` and print: "No project config found. Using default principles."

Let its `architecture`, `testing`, and `security` domain entries inform each task's scope and acceptance criteria (e.g. respecting `architecture_layering` when splitting a task across layers, citing a relevant `security_*` principle entry when writing security-specific acceptance criteria, or citing the relevant `t*` testing entry when writing the test decision bullet below).

For each task:
- **ID**: `{PREFIX}-{N}.{M}` — prefix is 2-3 letters from the feature name
- **Title**: short, verb-first (e.g., "Add billing schema migration")
- **Description**: what to build, not how
- **Acceptance Criteria**: 2-5 bullet points — specific, testable. Every task **must** include at least one test decision bullet that names: (a) which test layers are affected, (b) what tests are added (layer + scenario, e.g., "add integration test for X"), and (c) what existing tests are retired and why (be specific — "remove mocked unit test Y because real integration test now covers this path", not just "update tests"). If no test change is needed, state that explicitly and justify it.
- **Dependencies**: which tasks must complete before this task is ready — task IDs from this session or from prior open sessions (listed in Step 1.4); empty if none
- **Branch**: `feat/{id-lowered-dashes}-{first-3-words-kebab}` — or a shared branch name for bundled tasks (see below)
- **Layer**: API | Frontend | Database | Shared | Background | CLI
- **Hours**: rough estimate (1-8h; break tasks larger than 8h)
- **HITL**: `⚠ HITL` if the task is Type A (human executes directly) — see Step 5.5; omit otherwise
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

**Deploy gate for bundles:** The deploy cron holds until all tasks on the shared branch reach `pr_open` or beyond. A bundle PR will not be merged while any sibling task is still `pending`, `in_progress`, or `blocked`. This prevents shipping a PR that only contains half the bundle's work.

**⚠ `allow_auto_merge` bypasses the bundle gate.** GitHub's `allow_auto_merge` causes a PR to merge automatically as soon as checks pass — before the deploy cron runs its bundle-completeness check. Repos that use bundles **must keep `allow_auto_merge` disabled** (the repository default). If you need auto-merge for a specific flow (e.g., automated changelog PRs driven by a dedicated workflow), use a PAT-driven merge step scoped to that workflow only, not a repo-wide setting. On 2026-06-16 a bundle shipped with an incomplete sibling because `allow_auto_merge` was temporarily enabled on the repo; the bundle gate never fired.

**Same-branch scheduling exclusivity is automatic — no dependency edge needed.** Bundle-mate tasks that share a `branch` but have no `dependencies` edge between them still never dispatch concurrently: `task-store/src/ready.ts`'s ready-filter excludes a pending task from the ready set whenever another task on the same branch is `in_progress` with a fresh claim, serializing same-branch siblings automatically. This means the Dependency Map (Step 5's summary table) can legitimately show no edge between two bundle-mates even though they still execute one at a time — don't read a missing edge as a scheduling bug. The complementary backstop for the explicit-task-id dispatch path (which bypasses the ready-filter entirely, since it targets a task id directly rather than pulling from the ready set) is `dev-task.md`'s Same-Branch Sibling Check — the two mechanisms cover different dispatch paths and are not redundant with each other.

### Dependency Map

Present the map in two forms:

**1. Visual graph:**
```
[PRIOR SESSIONS]  ← include only if open cross-session tasks exist (Step 1.4)
  └─ {PRIOR-ID}: {title} [{status}]  (session: {prior_session})

[START]
  ├─ {PREFIX}-1.1: {title} (no deps)
  └─ {PREFIX}-1.2: {title} (no deps, depends on {PRIOR-ID} from prior session)
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

Before finalizing the task list, check each task for renames, removals, or constraint additions flagged in Step 2. For each one, the task must do one of:

1. **Atomic update** — include all consumer updates in the same task. One PR removes the old thing and updates every caller.
2. **Add → migrate → remove** — split into three sequential tasks: (a) add the new thing alongside the old, (b) migrate all consumers to the new, (c) remove the old.

A task that drops or renames something while a later task updates the consumers is not safe to deploy independently — that gap is a broken intermediate state in production.

**Same pattern for new constraints on existing tables.** A task that adds a `NOT NULL`, foreign key, or unique constraint to a column on a table with existing rows must split into sequential tasks the same way: (a) add the column/relation nullable, (b) backfill existing rows (with a task depending on (a), acceptance criteria requiring the live-data check above), (c) a later task adds the constraint — and only once (b)'s backfill has actually run and verified zero gaps, not just once its code has merged. A task that adds the constraint in the same migration as the backfill, or before the backfill task, risks failing on (or silently corrupting) existing rows.

If a task has no renames, removals, or constraint additions, mark it: `Safe to deploy standalone: yes`.

Present the task list and dependency map as a first pass. The engineer reviews and iterates — they may catch implementation details, missing edge cases, or better task splits. Iterate until approved.

### `--autonomous` Mode

When `--autonomous {task-id}` was passed, apply the same loose ambiguity bar from Step 4 to breakdown-level decisions (how finely to split a task, which layer a cross-cutting task belongs to, complexity/model scoring judgment calls) — skip the "iterate until approved" loop above and proceed directly to Step 5.5 once the first-pass breakdown is accepted.

- **Soft ambiguity** — the breakdown is silent, vague, or offers multiple reasonable readings on a breakdown-level decision, but a sensible default exists. Apply the default and append it to the same `## Decision Log` section started in Step 4 — do not stall or ask a clarifying question.
- **Hard contradiction** — e.g. a task can't be made to satisfy Breaking Change Safety, or its acceptance criteria can't be made testable. Do NOT fabricate an answer or silently pick a side. Stop immediately using the same escape hatch as Step 4:
  ```bash
  curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
    -d '{"status": "blocked", "hitl": true, "blockedReason": "plan_session_autonomous_hard_contradiction: {one-line description}"}' | jq .
  ```
  Then stop the command entirely — do not proceed to Step 5.5.

---

## Step 5.5: HITL Detection

Before writing tasks to the queue, scan every task for Human-in-the-Loop requirements. Classify each task into exactly one of two buckets:

- **Type A** — no real code / acceptance-criteria diff. The "task" is actually a set of manual steps: human executes commands or clicks directly (in a cloud console, provisioning a secret, running a privileged command outside the automated pipeline). This is the classic HITL case: it cannot be completed autonomously at all. Sets `hitl: true` and injects a `## Human steps` section.
- **Neither** — no HITL characteristics at all: `hitl: false`, no special handling.

Type A detection (keyword heuristic + judgment step below) is scoped to the "no real code diff, human executes commands directly" case.

### Keyword Heuristics (Type A detection)

Flag a task as HITL if its title or description contains any of the following keywords (case-insensitive):

```
terraform, helm, kubectl, GKE, GCP, deploy (image/cluster context),
container registry, image push, certificate, Cloud SQL, kube-context,
rollout, helm upgrade, kubectl apply, PAT, personal access token,
provision secret, GitHub settings, branch protection, allow_auto_merge,
.claude/
```

### Judgment Step (Type A detection)

Even without a keyword match, flag the task Type A HITL if it fundamentally requires:
- A human to act in a web UI (e.g., GCP Console, GitHub Settings, DNS registrar, cloud provider dashboard)
- Provisioning or rotating a credential, secret, or API key
- Approving a privileged workflow that requires human authorization
- Any action that cannot be expressed as a CLI command the agent can run
- Reading live production data to verify something (a backfill/attribution mapping, a data shape assumption) in a repo where the dev-task agent's normal execution environment cannot reach production databases directly — check the repo's `CLAUDE.md` for a rule to this effect. The keyword scan above won't catch this on its own since the trigger words (`kubectl`, `Cloud SQL`, etc.) typically show up only in acceptance criteria, not the task title/description — apply this judgment check explicitly for any backfill/migration task.
- Creating or modifying a file under `.claude/**` in the target repo — this is a distinct case from the others above: it is not blocked by any tool-permission configuration Shipwright controls, it is blocked unconditionally by the Claude Code CLI's own protection of its config/permissions/hooks directory. No amount of granted tool access changes this — flag it Type A HITL whenever the description, acceptance criteria, or identified file scope names a `.claude/**` path (e.g. `.claude/commands/*.md`, `.claude/settings.json`, `.claude/agents/*.md`).

**CI workflow secret scan**: if a task adds or modifies a CI workflow file, extract every `${{ secrets.* }}` reference in the changed file and check whether each secret name already appears in other workflow files in the repo. Any secret that is net-new — not referenced anywhere else — requires a human to provision it. Flag the task Type A HITL and list the new secret names in the `## Human steps` section.

Apply judgment: if the task description implies "someone must click approve in the console" or "create a secret in 1Password," it's Type A HITL regardless of the keywords present.

### How to Flag a Matched Task

For each task that matches the Type A keyword heuristic or judgment step:

1. **Set `hitl: true`** in its task JSON (see Step 6 templates)
2. **Inject a `## Human steps` section** into its description naming:
   - What access is required (e.g., "Requires: GCP Console IAM editor role")
   - Suggested command or action (e.g., `gcloud secrets versions add my-secret --data-file=- <<< "value"`)
   - Any pre-requisite setup (e.g., "Must have kube-context set to production cluster")
3. **Mark the task `⚠ HITL`** in the task table (HITL column)

The `## Human steps` section replaces what dev-task would otherwise try to autonomously execute, since there's no code to write.

Non-matching (Neither) tasks are unaffected — do not add a `## Human steps` section, and do not set `hitl: true` on them.

**Example Type A HITL description injection:**
```
{original description}

## Human steps
Requires: GCP Console access (Cloud SQL Admin role)
Action: Set the database password via Cloud SQL Studio or:
  gcloud sql users set-password app --instance=prod-db --password=<value>
Pre-requisite: Ensure kube-context is pointed at the production cluster before running migrations.
```

**Example Type A HITL description injection (`.claude/**` case):**
```
{original description}

## Human steps
Requires: direct repo write access outside the agent's own tooling.
Reason: the Claude Code CLI blocks agent writes under .claude/** unconditionally — this is not a Shipwright permission setting.
Action: a human applies the change to .claude/commands/docs-sync.md directly and pushes it to the branch.
```

After scanning, list any flagged tasks:
```
HITL tasks detected: {count}
{PREFIX}-X.Y — {title} — flagged by: {keyword match / judgment} (Type A)
```

If no tasks are flagged, print:
```
HITL scan: no tasks require human steps
```

---

## Configured Methodology Dispatch (PSM-1.2)

**Skip this entire section when `PLAN_SESSION_SUBAGENT_TYPE` is empty** — the built-in Steps 2
through 5.5 already produced the breakdown; proceed straight to Step 6. Everything below runs
only when Step 1 resolved `PLAN_SESSION_SUBAGENT_TYPE` to a non-empty value, in which case
Steps 2 through 5.5 were skipped and this section produces the breakdown in their place.

### Inputs

Assemble exactly the inputs `plugins/shipwright/references/methodology-contracts/plan-session.md`
specifies — no more, no less:

- **`specContent`** — the verbatim contents of `planning/{session}/PRODUCT-SPEC.md` as loaded
  (or, under `--autonomous`, materialized) in Step 1. Required — the contract defines no
  omission rule for it, so it is never omitted. When Step 1 found no spec file and fell back to
  asking **"What are we building?"** interactively (a path that never runs under `--autonomous`),
  pass the description collected in that exchange as `specContent` — the configured methodology
  receives the same field either way and is never dispatched with `specContent` missing.
- **`repo`** — the confirmed/dispatched `org/repo` value from the arguments.
- **`session`** — the session slug from the arguments.
- **`existingSessionTaskIds`** — the task ids returned by Step 1.3's dedup scan; omit when empty.
- **`openCrossSessionTasks`** — the `{id, title, status, session}` entries from Step 1.4's
  cross-session scan; omit entirely when none exist.
- **`testLayerDefs`** — normally loaded at the top of the (now-skipped) Step 2, so load it here
  the same way: if `docs/test-readiness/test-system.md` exists in the repo worktree, read it and
  pass its layer definitions; omit the field when the file is absent (a compliant subagent then
  falls back to the four built-in defaults itself).
- **`principles`** — normally loaded at the top of the (now-skipped) Step 5, so load it here the
  same way: check `.claude/shipwright/principles.md` in the project root first and pass its
  verbatim contents if present, otherwise pass `plugins/shipwright/references/principles.md`.
- **`autonomous`** — `{taskId: "{task-id}"}` when this command was invoked with
  `--autonomous {task-id}`; omit the field entirely otherwise.

### Dispatch

Dispatch via the Agent tool with `subagent_type: PLAN_SESSION_SUBAGENT_TYPE` and
`run_in_background: false`, passing a single prompt block that:

1. Points the subagent at `plugins/shipwright/references/methodology-contracts/plan-session.md`
   as the contract it must satisfy.
2. Supplies every input above, labelled with its contract field name.
3. States that the response must be exactly the contract's output JSON object — `tasks`,
   `planMarkdown`, `decisionLog`, `hardContradiction` — and nothing else.

Parse the response as that JSON object before doing anything with it.

#### Malformed or Failed Response

If the subagent returns malformed JSON, retry once with a reminder of the output schema. Treat
an outright failure of the dispatch itself (the Agent tool errors, or
`PLAN_SESSION_SUBAGENT_TYPE` names an invalid/nonexistent `subagent_type` from a misconfigured
override) identically to a malformed response for this retry — the retry re-dispatches the exact
same `PLAN_SESSION_SUBAGENT_TYPE`.

If the retry still fails, **abandon the session — there is no built-in fallback to dispatch.**
The built-in decomposition is not itself a dispatchable subagent (see Step 1's resolution
subsection), so there is nothing to hand off to; do not attempt to run Steps 2 through 5.5
inline as a substitute for the configured methodology, and do not re-dispatch a third time.

- **Under `--autonomous {task-id}`** — block the originating task and stop before Step 6:
  ```bash
  curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
    -d '{"status": "blocked", "hitl": true, "blockedReason": "plan_session_methodology_dispatch_failed: {subagent_type} failed after retry"}' | jq .
  ```
  Print `⚠ Task {task-id} blocked — configured plan-session methodology {subagent_type} failed after retry (plan_session_methodology_dispatch_failed).` and stop.
- **Interactive** — print a clear abort message naming the failed `{subagent_type}` and stop.
  No tasks are written; nothing is POSTed.

#### Hard Contradiction

If the parsed `hardContradiction` is non-null, the subagent hit a contradiction no default can
resolve. `tasks[]`/`planMarkdown` are empty or omitted in that case — do not salvage them.

- **Under `--autonomous {task-id}`** — mirror the Step 4/5 escape hatch exactly, using the
  returned text verbatim as the reason detail, and stop before Step 6:
  ```bash
  curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
    -d '{"status": "blocked", "hitl": true, "blockedReason": "plan_session_autonomous_hard_contradiction: {one-line description}"}' | jq .
  ```
- **Interactive** — the contract states `hardContradiction` is always `null` outside
  `--autonomous`, so a non-null value here is the configured subagent violating its own
  contract. There is no human-iteration loop to hand it to (the built-in Step 4/5 interactive
  loop lives in the steps this dispatch replaced) and no `{task-id}` to PATCH. Print a clear
  error naming `{subagent_type}` and the returned text, and stop before Step 6.

#### Schema Validation

Before ever reaching Step 6b's bulk POST, validate the returned response. This gate runs
**before Step 6**, client-side — the point is to catch malformed output here rather than let it
become an opaque Prisma error (or a task that hard-blocks one step downstream in `dev-task`)
after it has been written.

The gate has two parts: two **top-level** checks over the response object itself, then a list of
**per-task** checks over every entry in `tasks[]`. Keep the distinction in mind when reporting a
failure — a top-level failure is not attributable to any task id.

**Top-level — check the response object (not per-task):**

1. **`planMarkdown`** is present and a non-empty string. It is a required contract output that
   Step 6a writes to `planning/{session}/PLAN.md` verbatim, and nothing downstream re-derives it
   from `tasks[]`. A response carrying a perfectly valid `tasks[]` and an empty or missing
   `planMarkdown` clears every per-task check below, so without this check an `--autonomous` run
   — which has no human to notice — would write an empty `PLAN.md` and then point every queued
   task's `source` link at it.
2. **`tasks`** is present, an array, and **non-empty**. The contract describes `tasks[]` as
   "zero or more task objects"; this gate deliberately overrides that operationally and treats
   zero tasks as invalid output for a planning run, because an empty array is indistinguishable
   from success everywhere downstream. Every per-task check below passes vacuously over `[]`,
   and nothing server-side rejects it either: `/tasks/bulk`'s handler only requires a JSON
   array, and `TaskService.bulk()` gates on the upper `MAX_BULK_TASKS` cap only — an empty batch
   opens a transaction, creates nothing, and returns `200 {inserted: 0}`. Step 6b would read
   that as a successful POST, Step 6c would then transition the originating PRD task to `done`,
   and Step 6d would open a plan PR — so under `--autonomous`, where there is no human to notice
   zero work got queued, a decomposition that silently produced nothing would close out its own
   PRD task as complete. A methodology that genuinely has nothing to decompose must say so via
   `hardContradiction`, which has its own handled path above.

**Per-task — for each entry in `tasks[]`, check all of:**

1. **`id`** matches `{PREFIX}-{N}.{M}` — a 2-3 letter uppercase prefix, then `-{N}.{M}`.
2. **`branch`** is present and a non-empty string. `dev-task` hard-blocks any task with no
   branch, so a branchless task is never executable.
3. Every entry in **`dependencies`** resolves to a real task id — one of: another `id` in
   this batch's own `tasks[]`, an id in `existingSessionTaskIds`, or an id in
   `openCrossSessionTasks`. An unresolvable dependency id can never become ready.
4. **`repo`** equals the `repo` value passed in as an input, exactly. The contract specifies
   this field as "the `repo` passed in, unchanged" — a value contract, not just key-presence,
   so key-presence alone is not enough here. The bulk endpoint's own check is weaker in both
   directions: it requires only that the key exist, and `validateRepo` returns early on a
   literal `null`, so a task returned with `"repo": null` is written through and then
   undispatchable — `dev-task` derives its repo path and worktree path from `task.repo`, the
   same reason check 2 insists on `branch`. In the other direction a wrong or hallucinated
   `org/repo` passes format validation but fails `validateRepo`'s scope check, 400ing the
   entire batch *after* Step 6a has already written `PLAN.md`, with no recovery path defined —
   exactly the failure mode check 8 exists to prevent for colliding ids. Check 11 already
   holds `session` to this stricter value-equality standard; `repo` gets the same treatment.
5. **`title`** is a non-empty string.
6. **`status`** is exactly `"pending"`.
7. **`acceptanceCriteria`** is an array.
8. **`id` collides with nothing that already exists.** No returned `id` may match an entry in
   `existingSessionTaskIds` or an `id` in `openCrossSessionTasks`, and no two tasks in this
   batch may share an `id`. `/tasks/bulk` is create-only: a colliding id raises Prisma `P2002`,
   which the endpoint turns into a `409 Conflict` that rolls the entire batch back server-side.
   That 409 lands *after* Step 6a has already written `PLAN.md`, and this command defines no
   recovery path for it — so the collision has to be caught here, not discovered from the POST.
9. **`model`** is exactly one of `haiku` | `sonnet` | `opus`. The task store stores this column
   as a free-form string and does not enum-check it, so a wrong or invented tier is accepted
   silently and then dispatches the task at the wrong model.
10. **`layer`** is exactly one of `API` | `Frontend` | `Database` | `Shared` | `Background` |
    `CLI` — likewise an unvalidated free-form string server-side.
11. **`session`** equals the `session` slug passed in as an input. A task written with a
    different (or missing) `session` silently drops out of the session rollup, the admin
    Sessions view, and the session alert sweeper, even though the POST itself succeeds.
12. **`hitl`** is present and a boolean, and every task with `hitl: true` also carries a
    `## Human steps` section in its `description`. The task store column is a nullable boolean
    it never cross-checks against the description, and `task-store/src/ready.ts` excludes a task
    from the autonomous-ready set only on `task.hitl === true` — so a Type-A task returned with
    `hitl` omitted or wrongly `false` is silently queued as autonomous work for `dev-task`, and
    one returned `true` with no `## Human steps` section reaches `/shipwright:hitl` with no
    instructions to execute. Step 6b writes this flag through exactly as received on this path
    and does not re-run Step 5.5's detection over a dispatched breakdown, so this check is the
    only place it is caught.

Per-task checks 8 through 12 exist because the bulk endpoint cannot catch them for you: 8 fails
server-side only as an opaque 409 after the plan is already on disk, and 9-12 never fail
server-side at all — they are contract-constrained values the task store accepts as plain
strings (or, for `hitl`, as a nullable boolean). Check 4's value half is the same story from
both sides — a `null` `repo` is accepted silently, and a wrong one 400s the batch only after
`PLAN.md` is on disk. Neither top-level check has a server-side counterpart at all:
`planMarkdown` is never POSTed anywhere, it is only written to disk by Step 6a, and an empty
`tasks[]` is a clean `200` from `/tasks/bulk` rather than any kind of error.

**Any failing check — top-level or per-task — rejects the WHOLE batch, all-or-nothing.**
`/tasks/bulk` is itself a single transaction (any row failure rolls back the entire batch), so a
partial POST is never the right recovery, and a bad `planMarkdown` or an empty `tasks[]`
invalidates the response as a whole even when every task in it is clean (for an empty `tasks[]`,
vacuously so). Do not POST anything and do not write `PLAN.md`. Print one line per failure —
the task id and which check(s) it failed, or `planMarkdown` / `tasks` for the top-level checks:

```
⚠ Configured methodology {subagent_type} returned schema-invalid output — nothing written.
planMarkdown — failed: {check}
tasks — failed: {check}
{TASK-ID} — failed: {check(s)}
...
```

- **Under `--autonomous {task-id}`** — block the originating task and stop:
  ```bash
  curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
    -H "Content-Type: application/json" \
    "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
    -d '{"status": "blocked", "hitl": true, "blockedReason": "plan_session_methodology_schema_invalid: {summary}"}' | jq .
  ```
- **Interactive** — print the error above and stop.

Either way, **never proceed to Step 6 on validation failure.**

#### Interactive Approval

The built-in path's two approval gates — Step 4's "do not move to task breakdown until the
design is approved" and Step 5's "iterate until approved" — both live inside the steps this
dispatch replaced, and Step 6 still opens on an approved breakdown. Nothing in the dispatch
itself satisfies that precondition, so the gate is re-established here rather than skipped.

- **Under `--autonomous {task-id}`** — there is no approval gate, exactly as on the built-in
  path: Step 4's and Step 5's `--autonomous` subsections already replace iterate-until-approved
  with accept-first-pass. Treat the validated breakdown as approved and proceed to Step 6.
- **Interactive** — **do not proceed to Step 6 on the first response.** Present the returned
  breakdown to the human first — the `planMarkdown`'s design summary, its task table and
  Dependency Map, and any HITL-flagged tasks — then ask for approval explicitly. A subagent
  dispatched with `run_in_background: false` has no channel back to the user, so it cannot run
  the contract's interactive "keeps iterating with the human" loop itself; this command owns
  that loop on its behalf. On feedback, re-dispatch the same `PLAN_SESSION_SUBAGENT_TYPE` with
  the identical inputs plus the human's feedback appended to the prompt, re-run Schema
  Validation on the new response, and present it again. Repeat until approved. A re-dispatch
  for feedback is not a retry of a failed dispatch and does not consume the Malformed or Failed
  Response retry budget. Nothing is written to disk and nothing is POSTed until the human
  approves.

Once the breakdown has validated and — interactively — been approved, proceed to Step 6 exactly
as the built-in path would. Step 6 consumes this section's `tasks[]` as the task list and its
`planMarkdown` as the plan file's contents, written through verbatim. `decisionLog[]` needs no
separate handling in Step 6: per the contract its bullets are already embedded inside
`planMarkdown`'s `## Decision Log` section, so writing `planMarkdown` verbatim already carries
the decision log — do not append a second Decision Log section to the plan from the array.

---

## Step 6: Write to Queue

Once the task breakdown is approved, write the plan to disk and post tasks to the task store.
Step 6 is path-agnostic: it runs identically whether the breakdown came from the built-in
Steps 2 through 5.5 or from the Configured Methodology Dispatch section above — either way it
receives the same task list, plan markdown, and decision log, and either way the breakdown
reaching this step is already approved (by Step 4/5's iterate-until-approved loop, by the
dispatch section's Interactive Approval subsection, or by `--autonomous`
accept-first-pass). Where a sub-step below names Steps 4-5 or Step 5.5, read it as "whichever
path produced this breakdown" — on the dispatch path the equivalent content arrives on the
returned `planMarkdown` and `tasks[]` instead, and Step 6 writes it through rather than
re-deriving it.

### Bundle Model Inheritance (Pre-Write)

Before constructing any JSON, apply bundle inheritance to the full task list:

1. Group planned tasks by `branch`.
2. For each group with more than one task (a bundle), find the highest model tier present: `opus` > `sonnet` > `haiku`.
3. Set every task in that bundle to the highest tier before writing.

A task on its own branch is unaffected. This ensures a `haiku`-scored task bundled with a `sonnet`-scored task is written as `model: "sonnet"`.

---

**Step 6a — Save the plan to disk:**

Write the full plan markdown — session name, technical design, task table, Dependency Map, Breaking Change Safety notes, and (under `--autonomous`) the `## Decision Log` — **verbatim** to `planning/{session}/PLAN.md`. Create the directory if it doesn't exist.

Source-neutral, and verbatim either way: on the built-in path this markdown is what Steps 4–5 produced; on the Configured Methodology Dispatch path it is the returned `planMarkdown`, which the PSM-1.1 contract requires the caller to write through unchanged. **Do not re-synthesize the plan from the task list** — a re-synthesized plan silently drops the design rationale, the Breaking Change Safety notes, and the embedded Decision Log that the `source` link on every queued task points at.

This mirrors the PRD pattern (`planning/{session}/PRODUCT-SPEC.md`) and keeps the plan co-located with the spec that produced it.

**Link to the plan visualization (additive — never blocks the plan).** The
`PLAN.md` write above is complete and unchanged; this step only surfaces a
shareable link to the session view for what was just written. Skip cleanly
when the admin app base URL is not configured.

```bash
if [ -z "$SHIPWRIGHT_ADMIN_APP_BASE_URL" ]; then
  echo "⏭ Plan viz skipped — SHIPWRIGHT_ADMIN_APP_BASE_URL unset."
else
  PLAN_VIZ_URL="${SHIPWRIGHT_ADMIN_APP_BASE_URL%/}/admin/sessions/{session}"
fi
```

When `SHIPWRIGHT_ADMIN_APP_BASE_URL` is set, surface the constructed URL in the
Step 6 `QUEUED` confirmation as `Plan viz: {url}`. If the step printed a skip
notice instead, omit that line and proceed — the plan and its tasks are already
written and the command must never block on visualization.

When (and only when) a URL was produced, also emit `[plan:{url}]` on its own
line — the agent strips this marker and posts a "View plan" link to the bound
Slack channel/thread. Omit it if the step was skipped.

**Step 6b — Write tasks to the store:**

Write the tasks to `/tmp/new-tasks-{session}.json`. Set `source` to `"planning/{session}/PLAN.md"` on every task — this links each task back to the plan on disk:

```json
[
  {
    "id": "{PREFIX}-{N}.{M}",
    "source": "planning/{session}/PLAN.md",
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
    "hours": 2,
    "complexity": {complexity},
    "model": "{model}"
  }
]
```

Set `"hitl": true` (and include the `## Human steps` section in `description`) for every Type A HITL task in the breakdown, whichever path produced it — flagged by Step 5.5 on the built-in path, or already carried as `hitl: true` plus an injected `## Human steps` section on the returned `tasks[]` on the Configured Methodology Dispatch path. Step 6b writes the flag through as received on that path; it does not re-run Step 5.5's detection over a dispatched breakdown. That write-through is safe because the dispatch section's Schema Validation gate (check 12) already rejected any returned task whose `hitl` is missing or non-boolean, or whose `hitl: true` came without a `## Human steps` section — nothing unvalidated reaches this step.

Post the tasks to the store:

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
  --data-binary @/tmp/new-tasks-{session}.json | jq .
```

**Step 6c — Autonomous mode: close out the originating PRD task** (only when `--autonomous {task-id}` was passed):

Once Step 6b's bulk POST succeeds (real tasks are in the queue), transition the originating PRD task to `done` and point its `source` at the plan just written:

```bash
curl -sf -X PATCH -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks/{task-id}" \
  -d "{\"status\": \"done\", \"source\": \"planning/{session}/PLAN.md\"}" | jq .
```

Only run this after the bulk write succeeds — a failed or partial `tasks/bulk` POST must not mark the originating task done.

**Step 6d — Persist the plan to the repo (additive — never blocks the plan):**

Every task's `source` points at `planning/{session}/PLAN.md`, but that file only exists in *this* checkout — and many repos gitignore `planning/`. When the session runs inside an ephemeral agent workspace, the plan is lost with the pod unless it is committed. Open a docs-only PR carrying the plan so the `source` link resolves for everyone once it merges.

Run this after Step 6b succeeds (and after 6c when `--autonomous`). Use a throwaway worktree off the default branch so the current checkout's branch and working tree are never touched:

```bash
SESSION="{session}"
BRANCH="docs/plan-$SESSION"
PLAN_PR_URL=""
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ] || ! command -v gh >/dev/null; then
  echo "⏭ Plan PR skipped — not a git checkout or gh unavailable."
elif gh pr list --head "$BRANCH" --state all --json url -q '.[0].url // empty' | grep -q .; then
  PLAN_PR_URL=$(gh pr list --head "$BRANCH" --state all --json url -q '.[0].url // empty')
  echo "⏭ Plan PR already exists: $PLAN_PR_URL"
else
  git -C "$REPO_ROOT" fetch -q origin
  DEFAULT=$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
  WT=$(mktemp -d)/plan-wt
  # -B (not -b): a prior run may have created this branch and then failed after
  # push but before `gh pr create` — reset it to $DEFAULT instead of erroring out,
  # so a retry isn't permanently wedged on "branch already exists".
  git -C "$REPO_ROOT" worktree add -q -B "$BRANCH" "$WT" "$DEFAULT"
  mkdir -p "$WT/planning/$SESSION"
  for f in PLAN.md PRODUCT-SPEC.md; do
    [ -f "$REPO_ROOT/planning/$SESSION/$f" ] && cp "$REPO_ROOT/planning/$SESSION/$f" "$WT/planning/$SESSION/$f"
  done
  # -f: planning/ is commonly gitignored. Stage only these files — never -A.
  git -C "$WT" add -f "planning/$SESSION/PLAN.md" "planning/$SESSION/PRODUCT-SPEC.md" 2>/dev/null \
    || git -C "$WT" add -f "planning/$SESSION/PLAN.md"
  # Mechanical scrub gate — planning/ is gitignored precisely because it can carry
  # internal detail, and --autonomous runs with no human present to catch it. Block
  # the commit on the same class of pattern a secret scanner flags: private key
  # headers and well-known cloud/vendor token prefixes.
  SECRET_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}'
  if git -C "$WT" diff --cached --quiet; then
    echo "⏭ Plan PR skipped — plan already on $DEFAULT."
  elif git -C "$WT" diff --cached | grep -qE "$SECRET_PATTERN"; then
    echo "⚠ Plan PR not opened — staged plan content matched a secret-pattern scan; scrub planning/$SESSION and retry."
  else
    git -C "$WT" commit -q -m "docs(planning): add $SESSION plan" \
      && git -C "$WT" push -qf -u origin "$BRANCH" \
      && (cd "$WT" && gh label create shipwright --description "Opened autonomously by Shipwright" --color 1D76DB --force) \
      && PLAN_PR_URL=$(cd "$WT" && gh pr create --head "$BRANCH" --base "${DEFAULT#origin/}" \
           --title "docs(planning): add $SESSION plan" \
           --body "Plan for session \`$SESSION\` — the \`source\` of every task in this session." \
           --label shipwright)
  fi
  git -C "$REPO_ROOT" worktree remove --force "$WT"
fi
```

The block above runs a mechanical secret-pattern scan over the staged diff before committing — never rely on prose discipline alone here, since `--autonomous` is the only mode this runs in and no human reviews the commit before it lands. If the repo has its own stricter pre-commit hygiene (a public repo's banned-string scan, or its CLAUDE.md rules on client names and internal infra identifiers), apply that too. If a file fails either check, or any command above fails, print `⚠ Plan PR not opened — {reason}` and continue: the tasks are already queued and the command must never fail on this step. A pre-existing PR for the branch (open or merged) counts as done — do not open a second one.

The `gh label create` step uses `--force` to make it idempotent — it will upsert the label if it already exists rather than erroring — same convention applied across Shipwright skills for autonomously-opened PRs (see `research-docs.md` Step A7.5, `SKILL.md` Step 3.5 in `skills/test-readiness/`).

When a PR was opened (or already existed), surface it in the confirmation as `Plan PR: {url}`; otherwise omit that line.

---

Confirm with:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUEUED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session: {session}
Plan: planning/{session}/PLAN.md
Plan viz: {url}   ← omit this line if the render step was skipped
Plan PR: {url}    ← omit this line if Step 6d skipped or failed
Tasks queued: {count}

READY TO START (no dependencies):
{list tasks with no deps}

BLOCKED (waiting on deps):
{list tasks with deps → what they're waiting on}

The execution cron will pick up ready tasks automatically.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

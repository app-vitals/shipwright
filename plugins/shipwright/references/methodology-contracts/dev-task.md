# Dev-Task Methodology Contract

The interface any subagent plugged into the "dev-task" pipeline phase's **Step-5-only swap**
must satisfy — whether that's the built-in behavior (Step 5 of
`plugins/shipwright/commands/dev-task.md`) or a custom, operator-supplied subagent swapped in
via a per-agent, per-phase `AgentPhaseMethodology` override (`phase -> subagentType or null`,
phase value `"dev-task"`). The `/shipwright:dev-task` command is the caller: it owns task
fetch/claim (Steps 1-2), building the implementation brief (Step 3), worktree setup and
toolchain detection (Step 4, Step 0/0b), dispatching whichever subagent is configured for the dev-task
phase's implementation step (Step 5) with the inputs below, and everything that runs after —
Simplify, spec compliance, requirements verification, pre-ship checks, docs refresh, PR
creation, the CI-fix loop, and the task-store handoff (Steps 6 through 10) — none of that is
delegated. A drop-in replacement for the built-in implementation subagent must accept exactly
these inputs and return exactly this output shape — the caller has no other integration point
and does no phase-specific adaptation.

> **Subagent selection is wired up (DTM-1.2).** A per-agent, per-phase `AgentPhaseMethodology`
> record (`{phase, subagentType | null}`, with `dev-task` as a valid phase key) exists as a
> Prisma model plus CRUD service in `admin/src/agent-phase-methodology.ts`.
> `commands/dev-task.md`'s Step 5a.5 reads `phaseMethodology["dev-task"]` off
> `GET /agents/{id}/config` once per run and resolves `DEV_TASK_SUBAGENT_TYPE` — falling back
> to the built-in `general-purpose` when no override is configured, or on any lookup failure
> (fail-closed, never fail-open). Step 5b dispatches `DEV_TASK_SUBAGENT_TYPE` instead of a
> hardcoded literal. This contract specifies the wire shape any subagent plugged in this way
> — built-in or operator-configured — must satisfy.

`plugins/shipwright/commands/dev-task.md`'s Step 5 (5a through 5d) is the **reference
implementation** this contract was extracted from — TDD red-green-refactor enforcement,
spawning the `shipwright:researcher` agent for discovery, the model-escalation ladder on a
BLOCKED report (haiku → sonnet → opus), and the claim-heartbeat renewal that brackets the
dispatch. Consult it for the full built-in implementation and escalation logic; this doc only
specifies the wire shape, not implementation policy.

## Inputs

- **Implementation Brief** — the task fields assembled in Step 3, carried into the dispatch
  prompt verbatim:
  - **`title`** — the task's title.
  - **`description`** — the task's description.
  - **`acceptanceCriteria`** — the task's acceptance criteria, as a list.
  - **`layer`** — the task's declared layer (e.g. `Shared`, `API`, `Database`). Distinct from
    a *test* layer (`unit`/`integration`/`smoke`) — those arrive via the `tests` object in the
    toolchain commands below.
- **Repo context**:
  - **`worktree-path`** — the already-prepared worktree the subagent works inside. The
    subagent does **not** create a new branch — Step 4 has already created and checked out
    the task's branch before dispatch; the subagent commits directly onto it.
  - **CLAUDE.md contents** — the project's root `CLAUDE.md`, read by the caller in Step 5a
    and passed in full so the subagent follows existing conventions.
  - **Toolchain commands** — resolved by Step 0/0b before dispatch: the test command, any
    per-layer test commands (`tests` from the toolchain cache, when the project has more than
    one test layer), the validate command, and the typecheck command (or `"none"`).
- **TDD requirement** — dev-task's one non-negotiable policy constraint, stated explicitly in
  every dispatch: red-green-refactor is **required** — no production code is written before a
  failing test exists. When the brief specifies Expected Tests, those are the RED-phase
  starting point.

## Output

A dev-task-phase subagent's output is **dual** — a text report, plus the actual committed
code changes left on disk. This is a deliberate difference from the review/patch/deploy
contracts, whose callers parse the subagent's returned text as the entire result: here, Step 6
onward (Simplify, spec compliance, requirements verification) all operate on `git diff
main...HEAD` — they re-derive what changed by reading the branch's commits, not by parsing
anything out of the subagent's report. The report below is what the caller uses to decide
whether to proceed to Step 6, re-dispatch, or escalate; the commits are what Step 6 onward
actually consumes as "code changes made, ready for Step 6 onward."

```
STATUS: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED

CONCERNS: {if DONE_WITH_CONCERNS}
BLOCKER:  {if BLOCKED}
```

- **`status`** — one of `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED`.
- **Committed code** — whenever `status` is not `BLOCKED` and not `NEEDS_CONTEXT`, the
  subagent must have committed its work to the worktree's branch using conventional commit
  messages before reporting. A compliant subagent never reports `DONE` with uncommitted
  changes left in the worktree — the caller's Step 6 (`git diff main...HEAD`) would see
  nothing to simplify.
- **`concerns`** — free text, present when `status` is `DONE_WITH_CONCERNS`. Covers
  observations that didn't block completion (e.g. "this file is growing large") as well as
  correctness or scope gaps the caller should address before Step 6.
- **`NEEDS_CONTEXT`** — the subagent is missing information required to proceed (not itself a
  failure state). The caller supplies the missing context and re-dispatches with the same
  prompt augmented with the answer; the subagent does not have its own means of asking a human
  directly.
- **`blocker`** — free text, present when `status` is `BLOCKED`. **BLOCKED is the
  escalate-to-HITL decision** — but the subagent itself does not perform the actual escalation
  mechanics. It does not PATCH the task record `blocked`, and it does not decide which model
  tier to retry at. The caller (`/shipwright:dev-task`) is the one that runs the
  model-escalation ladder (Step 5c: haiku → sonnet → opus, re-dispatching once per tier with
  the same prompt plus the blocker context appended) and, only after that ladder is exhausted,
  PATCHes the task `blocked` with `blockedReason: "implementation_blocked_after_model_escalation"`
  — the same "caller performs the actual side effect, subagent only reports a verdict" pattern
  the patch- and deploy-phase contracts use for their own escalation/status transitions.

## Scope

This contract covers only the wire shape between the caller and the dev-task phase's
Step-5-only implementation subagent — what goes in, what comes back. It says nothing about
how the subagent internally decides its architecture, which patterns it follows, or how it
structures its own discovery/testing/refactor passes; those are the concrete implementation's
concern (see `commands/dev-task.md` Step 5 for the reference implementation's TDD and
discovery logic).

**Steps 6, 6.5, 8.5, and 9b are unconditional and out of scope for this swap.** They run
regardless of which subagent produced the code in Step 5 — there is no configuration that
skips or replaces them:

- **Step 6 (Simplify)** — a simplification pass over `git diff main...HEAD`, already
  independently swappable via a project's `principles.md` override, but always runs after
  Step 5 completes.
- **Step 6.5 (Spec Compliance Check)** — an independent `haiku`-tier subagent verifies the
  diff against the task's acceptance criteria and triggers an auto-fix loop back through Step
  5 on any NOT MET/PARTIAL criterion.
- **Step 8.5 (Auto-Refresh Docs)** — the `shipwright:docs-refresher` agent runs against the
  branch's diff and commits a docs-only commit when anything is stale.
- **Step 9b (CI Gate)** — the post-PR merge-conflict check and CI-fix loop (up to 6 retry
  attempts) runs against whatever GitHub Actions reports for the pushed branch, independent of
  which subagent authored the original commits.

None of these four steps are bypassable or configurable per swapped-in Step-5 subagent — a
compliant integration does not attempt to skip them, and the caller does not offer a
mechanism to do so.

It also says nothing about what the caller does with the output afterwards, and several
responsibilities stay entirely with the caller, never delegated to the subagent:

- **Task fetch, validation, and claim** (Steps 1-2) — the caller alone fetches the task from
  the task store, validates it (branch field, PRD-shaped guard, dependency check, same-branch
  sibling check), and performs the atomic claim; the subagent never touches the task-store API
  directly.
- **Worktree setup and toolchain detection** (Step 4, Step 0/0b) — the caller prepares the
  worktree, checks out the branch, and resolves the test/lint/typecheck/validate commands
  before dispatch; the subagent works inside an already-prepared worktree and does not resolve
  its own toolchain.
- **Model-tier resolution and escalation** (Step 5b/5c) — the caller resolves which model tier
  the dispatch runs at (`task.model ?? 'sonnet'`) and owns the haiku → sonnet → opus escalation
  ladder on a BLOCKED report; the subagent does not choose its own tier.
- **Claim-heartbeat renewal** (Step 5b/5d) — the caller renews the task-store claim heartbeat
  immediately before and after Step 5's dispatch so the stale-claim reaper does not reclaim the
  task mid-implementation; the subagent has no visibility into or responsibility for the claim
  TTL.
- **Branch naming, PR creation, and task-store status transitions** (Steps 1/2/4/9/10a) — the
  branch is created before Step 5 ever runs, the PR is opened after Steps 6 through 9b
  complete, and every task-store status PATCH (`in_progress` → `pr_open`, `blocked`, etc.)
  happens in caller-owned steps the subagent never touches.

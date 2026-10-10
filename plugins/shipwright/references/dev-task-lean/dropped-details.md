# Intentionally dropped from dev-task-lean

Everything else in `commands/dev-task.md` was moved to a sibling reference file. These items were cut. Git history
(`git log -- plugins/shipwright/commands/dev-task.md`) (commit titles) suggest each addition refined the same pipeline rather than fixing a
one-off incident; AGH-1.1 (wakeups) is preserved in `pre-ship-checks.md` and `push-and-ci.md`.

| Dropped | Reason |
|---|---|
| Step 0 "Detect Project Toolchain" heading (duplicate of Step 1's 0b) | Same procedure stated twice in the original; kept once in `task-lifecycle.md`. |
| Step 3 as a separate step | Brief assembly is folded into Step 5; the brief template is now in `implementation-dispatch.md`. |
| Step 5 "CRITICAL — DO NOT SKIP STEPS 6–10" banner | Replaced by per-step **Proof** lines and the no-size-exemption rule (#4197), which carry the same intent measurably. |
| Duplicate "Task size is never grounds for skipping" paragraph | Collapsed to one sentence in the preamble. |
| Doubled Coverage/Build & Lint prose and the example toolchain list in Step 8 | Examples (cargo, go, pytest, ...) are discoverable from `toolchain-patterns.md`. |
| PR Failure Cleanup step 5–6 (reset planning-doc status, `chore: reset` commit) | Obsolete: tasks live in the task store, not a planning doc; the blocked PATCH replaces them. |
| Step 6.5 "Feature Overview / Implementation Decisions from planning doc" prompt fields | Sourced from a planning doc the store-based flow no longer provides; the criteria and diff are the spec. |
| Step 7 references to "Step 2 acceptance criteria extraction" | Criteria come from the fetched task in Step 1. |

# Plan Session: lvb-simplify

Repo: app-vitals/shipwright

## Background

The local-verification-budget (LVB) planning session (PRs #3617–#3660) added two mechanisms
to `dev-task.md`/`patch.md` that turned out to add more agent-executed complexity than they
needed to:

1. **Enforced timeout/budget wrapper (LVB-2.1/2.2, PR #3621).** The `setsid timeout
   --kill-after=... & CMD_PID=$!; wait $CMD_PID; ...; kill -TERM/-KILL -$CMD_PID` snippet is
   duplicated as raw inline bash in 4 places: dev-task.md Step 8, and patch.md Steps 4b/5b/6c.
   It also has a live correctness bug: bare `setsid` (without `--wait`) forks and returns
   immediately, so `wait $CMD_PID` captures setsid's own near-instant exit and reports a false
   `EXIT=0` while the real command is still running — the subsequent `kill -TERM/-KILL
   -$CMD_PID` then kills it mid-flight. A check can report a clean pass for a command that
   never finished. Caught live on PR #3653 by a patch fix-subagent; not yet fixed anywhere.

2. **Learned-facts / skip-locally doc write-back mechanism (LVB-4.2/4.4, PRs #3651/#3660).**
   dev-task.md Step 8 locates a markdown doc, derives a heading's nesting level via an awk
   `#`-counting recipe, and parses a markdown table out of prose into an in-memory map, just to
   answer "has this repo learned to skip check X locally?" Step 8.6 then re-derives that
   heading level, full-replaces a `Shipwright Learned Facts` marker subsection via the Edit
   tool, and git-commits it onto the task's branch every run. The toolchain-cache fingerprint
   logic has to explicitly exclude that exact subsection from its own hash to avoid
   self-invalidating on its own writes.

## Decision: doc-write value assessment

Before redesigning, checked whether the learned-facts doc write actually feeds back into
dev-task/patch behavior:

- **Scoped-command-variants and the enforced budget value are never read back from the doc.**
  Step 0/0b's cache-reuse path reads `state/toolchain-cache/{repo}.json` exclusively. Step 8
  re-derives `{budget}` from `gh run list`/fallback on every run regardless of any prior
  recording. The doc write is a pure sink with zero functional effect on speed or correctness —
  purely a human-visibility nicety, and best-effort/silently-skipped on failure, so it isn't a
  reliable consistency mechanism either (and only `dev-task` writes it — `patch` never does, so
  it can drift even when it does land).
- **Skip-locally classification** is genuinely machine-consumed (Step 8's read-before-attempting
  check), but the same data is already queryable live from `GET
  /verification-checks?repo=&checkName=` — the repo+check history endpoint LVB-4.4 built in the
  same PR. Routing the read (and the now-deleted write) through a git-committed markdown doc
  instead of that endpoint was pure duplication.

**Conclusion:** drop the doc-write entirely for both fact categories (scoped-command-variants +
budget, and skip-locally classification). No functional capability is lost. This removes Step
8.6, the "Writing Learned Facts Back to Docs" section, the heading-level derivation logic, and
the fingerprint's marker-subsection exclusion — all of it, not a lighter-weight replacement
format.

**LVB-4.3 (PR #3654, open/approved/CI-green) is unaffected.** Its pointer-relocation-search
logic serves the `docsSource` fingerprint used by Step 0b's cache-reuse decision — a separate,
still-functional path independent of the learned-facts write being removed here. Only the
fingerprint's marker-subsection-stripping lines (which exist solely to keep the write from
self-invalidating its own cache) become dead code once the write is gone; that cleanup is folded
into LVBS-1.2 rather than given its own task.

## Design

**LVBS-1.1 — Shared budget-wrapper script.** New `plugins/shipwright/scripts/run-with-budget.ts`,
matching the existing `is-ci-green.ts` convention (standalone, no `@shipwright/lib` dependency,
invoked via `bun run "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-budget.ts"`). Wraps a command with
`setsid --wait timeout --kill-after={n}s {budget}s {command}` (the `--wait` fixes the false-green
bug), plus the whole-process-group kill as cleanup, and prints `{status, exitCode, durationMs}`
JSON to stdout so callers can parse with `jq`.

**LVBS-1.2 — Wire dev-task.md Step 8.** Replace the inline `setsid timeout ...` block with a call
to `run-with-budget.ts`. Replace the doc-table skip-locally read with a direct
`GET /verification-checks?repo=&checkName=` call (same consecutive-streak counting logic Step 8
already does for the *write* side, now also driving the read side against the same endpoint —
no doc involved). Delete Step 8.6 in full. Delete toolchain-patterns.md's "Writing Learned Facts
Back to Docs" section and the Fingerprint recipe's marker-subsection-stripping lines (dead once
nothing writes the marker).

**LVBS-1.3 — Wire patch.md's 3 validate sites (Steps 4b/5b/6c).** Same two changes as LVBS-1.2,
applied at all three call sites. patch.md remains read-only against skip-locally classifications
(same asymmetry LVB-4.2 established — dev-task is the only writer, and after this change dev-task
writes only to `/verification-checks`, never to a doc).

## Task Table

| Task | Title | Depends on | Layer | Hours | Complexity | Model | HITL |
|---|---|---|---|---|---|---|---|
| LVBS-1.1 | Add shared run-with-budget.ts script | — | Shared | 3 | 3 | sonnet | |
| LVBS-1.2 | Wire dev-task.md Step 8 to budget script + API-based skip-locally; delete learned-facts doc write | LVBS-1.1 | CLI | 5 | 4 | sonnet | |
| LVBS-1.3 | Wire patch.md's 3 validate sites to budget script + API-based skip-locally | LVBS-1.1 | CLI | 4 | 3 | sonnet | |

**Dependency graph:**
```
[START]
  └─ LVBS-1.1: shared run-with-budget.ts script (no deps)
        ├─ LVBS-1.2: wire dev-task.md Step 8 (needs 1.1)
        └─ LVBS-1.3: wire patch.md's 3 sites (needs 1.1)
```

**Breaking-change scan:** none of the three tasks rename or remove any public API surface.
`/verification-checks`'s `repo`+`checkName` query mode already exists (LVB-4.4). Removing Step
8.6 removes agent-internal behavior only — no external consumer. All three: **safe to deploy
standalone: yes**.

**HITL scan:** no tasks require human steps.

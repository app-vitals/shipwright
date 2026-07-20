# Pre-Filing Verification Checklist

A single-pass, non-interactive validation checklist read by all five automated fix skills
(`entropy-fix`, `error-fix`, `security-fix`, `consolidation-fix`, `test-fix`) before they
convert a scan finding into a task-store task. This checklist ensures findings are current
and actionable at the moment of queuing, preventing stale, already-fixed, or
collision-vulnerable tasks from entering the queue.

> **Important distinction from plan-session:** This is a **single-pass, autonomous check**
> — no human feedback loop, no iteration, no waiting for response. When a check fails or
> returns inconclusive, findings route to HITL as a flagged, queued item for later human
> review, not as an interactive prompt awaiting a live answer. The `/shipwright:plan-session`
> flow is interactive by design (iterating on human feedback); pre-filing-verification is
> not. This checklist runs at 4am cron time with no human present.

---

## Checklist Item 1: Verify Current File / Line Existence

**Before trusting a finding's location, read the actual current file(s) and line(s) in the
live repository.** Never accept the scan report's snapshot as ground truth — the repo
changes between scan and fix-skill execution, sometimes within seconds (especially in
high-velocity repos and continuous integration loops).

### How to Apply It

1. For each finding with a file path and line number, use `git show HEAD:<file>` or read
   the file directly from the working tree.
2. Search for the exact line of code or pattern the finding names.
3. If the line does not exist at that location, or if the file has been deleted, stop. Do
   not file a task. Log it to whatever tracking mechanism the calling skill maintains
   (e.g., entropy-fix's dedup ledger, error-fix's skipped-on-stale list).

### Example: Stale Snapshot

A scan run 2 minutes ago flagged `src/handler.ts:45` with `dead_exports: exported function
'processPayment' is never imported`. Your fix skill re-reads the file now and finds:

```typescript
// src/handler.ts, line 45 — current state
// Function deleted in commit abc123 (2 minutes ago)
// Line 45 is now a different function: handleCallback
```

The finding is stale. Do not queue a task. Log it in your ledger as "stale — line moved" or
skip the finding silently per your skill's own convention. Re-running the find-skill on a
future scan will either re-discover the issue (if it still exists) or confirm it's gone.

---

## Checklist Item 2: Confirm the Gap Is Still True

**Re-read the finding's described problem against the current code.** The gap may have been
fixed on main or a sibling branch since the scan completed, or the code may not have the
issue the scan report describes.

### How to Apply It

1. Read the finding's description (what gap it names — "function never imported",
   "authorization check missing", "hardcoded secret", "duplicate utility", etc.).
2. Check the actual current code against that description.
3. If the gap is already fixed (the function is now imported, the auth check exists, the
   secret was removed, the duplicate was consolidated), drop the finding. Do not file a
   task. Log it in your skill's ledger as stale/already-fixed.

### Example: Already Fixed on Main

A scan flagged `src/auth.ts:12` with `missing authn_boundary: handler reaches data layer
without auth check`. You re-read the file and find:

```typescript
// src/auth.ts, line 12 — current state
export async function protectedRoute(req) {
  const user = await validateSession(req); // Auth check added in commit def456
  if (!user) return 403;
  return await database.query(...);
}
```

The auth check is already there. The finding is stale. Skip it. Log it as "stale — auth check
landed on main 4 days ago before fix-skill run."

---

## Checklist Item 3: Do Not Assume False-Negatives Are Safe to File Clean

**If a finding's existence or staleness cannot be confirmed with a literal, direct check,
do not assume it's safe to skip.** Route it to HITL instead.

This guards against the class of bugs where literal substring matching misses a real
reference built dynamically at runtime (e.g., via `path.join()`, constructor dispatch, or
other indirection).

### How to Apply It

1. For each finding, assess whether your re-check is a literal, definitive answer.
2. **Literal checks that are safe to skip if they fail:** a hardcoded import statement
   (`import { foo } from "module"`), a direct function call by name (`processPayment()`),
   a config file entry in YAML or JSON that names the symbol directly.
3. **Indirect checks that are NOT safe to skip if they fail:** a file path constructed via
   `path.join(directory, filename)`, a service dispatcher that selects handlers by a
   string key read from a config, a reflection-based plugin loader that instantiates
   classes by name. A grep-based substring check on these patterns will false-negative
   because the reference is built dynamically.

### Example: Indirect Reference (Grep False Negative)

A scan flagged `src/plugins/handler.ts` with `unreferenced_files: no import sites found`.
Your fix skill searches the repo for `"handler"` and finds nothing. But the code actually
loads it like this:

```typescript
// src/plugin-loader.ts
const handlerPath = path.join(__dirname, `handlers/${req.service}.ts`);
// At runtime: if req.service === "handler", loads src/plugins/handler.ts
```

A literal grep for "handler" missed the `path.join()` construction. You cannot confirm
whether the file is truly unreferenced. Do not skip silently with "grep found nothing."
Instead, route the finding to HITL with a note: "Could not confirm unreferenced status —
uses dynamic path construction; needs human judgment."

---

## Checklist Item 4: Avoid Task ID and Branch Name Collisions

**Task IDs and branch names are scoped to prevent collisions when the same rule is active
in multiple repos during the same cycle.** Verify that no existing pending or in-progress
task already owns this ID/branch namespace.

### How to Apply It

1. Extract the repo name from `git remote get-url origin` (format: `org/repo`).
2. Derive the repo slug: last path segment, lowercased (e.g., `app-vitals/shipwright` →
   `shipwright`).
3. Compute the task ID your skill will generate (format varies per skill, but always
   includes `repo-slug` as a namespace segment — e.g.,
   `entropy-dead_exports-shipwright-2026-W23`).
4. Query the task store for any existing pending/in-progress task with the same ID.
5. If a match is found, skip this finding. Log it as "task already active."

### Example: Multi-Repo Collision

Two repos (`org/shipwright` and `org/other-repo`) are scanned in the same ISO week (W23)
for the same rule (`dead_exports`). Without repo-slug scoping, both would generate the
same task ID (`entropy-dead_exports-2026-W23`), causing the second repo's findings to
overwrite the first in the queue (or be silently rejected as a duplicate).

With repo-slug scoping:
- `org/shipwright`: `entropy-dead_exports-shipwright-2026-W23` ✓ unique
- `org/other-repo`: `entropy-dead_exports-other-repo-2026-W23` ✓ unique

Each skill that generates task IDs already encodes repo-slug in the ID format — verify
this is being done when you implement the fix skill, and trust the dedup check in your
skill's "6q.1"-style step (querying task-store for existing tasks by repo) to catch
any collision attempts before they are queued.

---

## Ledger and Tracking

Each fix skill maintains its own ledger or output format for tracking verification results:

- **entropy-fix**: dedup check output (Step 6q.1), cross-check deferred findings (Step 6q.2),
  final summary (Step 6q.6)
- **error-fix**: skipped-on-fetch-failure (Step 3), unmapped issues surfaced for triage (Step 2)
- **security-fix**: same dedup check pattern as entropy-fix (via Step 3/Step 6)
- **consolidation-fix**: cross-check against consolidation-decisions.md (Step 3)
- **test-fix**: dedup check (Step 4), final summary listing skipped/deferred items

There is no unified, centralized ledger for pre-filing verification across all five skills.
Each skill logs its findings to its own skill's output/ledger as part of its natural flow.
When a finding fails a pre-filing check, log it using whatever mechanism your fix skill
already employs for tracking skipped/stale/deferred items — do not invent a new tracking
surface.

---

## Non-Interactive, Single-Pass Design

This checklist is **performed autonomously by a scheduled cron or an agent with no human
present** — typically at 4am in an automated pipeline. Its purpose is to filter stale
findings and prevent collision-vulnerable tasks from entering the queue in the first place.

**When a check fails:** the finding is logged (not filed as a task) and surfaces to a human
later via the skill's output summary or ledger. A human can then review the logs,
re-run the scan if needed, and decide whether to re-queue the finding.

**Contrast with `/shipwright:plan-session`:** plan-session is an **interactive design-approval
loop** that iterates on human feedback. A planner proposes an architecture, a human reviews
it, the planner refines based on feedback, and the cycle repeats until both are satisfied.
Pre-filing verification performs no such iteration — it makes a single, definitive check,
and if the check is inconclusive (indirect references, dynamic construction), the finding
routes to HITL as data, not as a prompt awaiting a live response. The human reviews the
HITL queue later, asynchronously.

---

## Summary

Before a fix skill queues a finding as a task-store task, apply these four checks in order:

1. **Verify the file and line exist in the current repo state.**
2. **Confirm the described gap is still true in the current code.**
3. **If existence/gap cannot be confirmed by a literal check, route to HITL (do not assume
   false-negatives are safe).**
4. **Check for task ID and branch name collisions with existing pending/in-progress tasks
   in the same repo.**

Log results to your skill's existing tracking mechanism (dedup ledger, summary output,
etc.). Stale or collision-risky findings are skipped; inconclusive findings route to HITL.

# Test-Readiness Pipeline Learnings

A running, cross-repo log of what the test-readiness pipeline (test-inventory →
test-system → test-migration → test-roadmap) learned about its *own* process while
executing against a real repo — places where a skill's assumptions didn't match
reality, or a task's prescribed verification command needed repo-specific adjustment.

**Consult this file** before/during a new pipeline run against a repo you haven't
run against before — it's the fastest way to avoid a mistake someone already made.

**Append to this file** after a pipeline run if you hit a mismatch between a skill's
assumptions and the target repo, or had to adapt a verification command. One dated,
repo-attributed entry per run; keep each lesson terse and actionable, not prose.

---

## 2026-07-15 — shipwright

1. **Doc-anchors aren't guaranteed to exist on the target branch.** Several
   `test-t-0XX` tasks' Context sections reference
   `docs/test-readiness/test-migration.md` and
   `docs/test-readiness/test-readiness-plan.md` as if merged to `main`. In this run,
   neither file existed on `main` (`git show HEAD:docs/test-readiness/test-migration.md`
   fails) — they only lived on an orphaned, never-opened branch. Only
   `docs/test-readiness/test-system.md` was actually on `main`. **Lesson:** verify a
   referenced doc actually exists on the target branch before trusting it as ground
   truth; if it's missing, verify the underlying claim directly (re-run the test/build
   the diff shows) instead of blocking on the doc link.

2. **A task's verification command may assume workflow-file granularity that doesn't
   match the repo's CI shape.** A task expected new CI wiring to be a standalone
   GitHub Actions workflow file (`gh run list --workflow=admin-e2e.yml`), but this repo
   added the equivalent wiring as a *job* inside the existing `ci.yml` workflow, so the
   command 404s even though the work is real and passing. **Lesson:** when a
   `--workflow=<name>` lookup 404s, fall back to `gh api
   repos/{repo}/actions/runs/{run_id}/jobs` and check job names within the monorepo's
   existing workflow(s) before concluding the work wasn't done.

3. **The 80/80 coverage gate can fail in-sandbox for reasons unrelated to the diff.**
   `scripts/check-coverage.ts` (`task ci` / `task test:coverage`) can dip below
   threshold inside an agent sandbox because there's no test database, so integration
   tests silently skip (`describeOrSkip` or similar) instead of running, dragging the
   aggregate down. **Lesson:** this is a sandbox environment gap, not a regression —
   compare the coverage/test outcome against a clean checkout of `main` in the same
   sandbox before treating a coverage-gate failure as caused by the diff.

4. **Task IDs don't embed which repo minted them — risk of cross-repo collision.**
   Task IDs from this pipeline (e.g. `T-032`) are not repo-namespaced. If the same
   ISO week's batch runs across two repos, a bulk task-creation POST keyed only by
   task ID can silently no-op the second repo's batch, since the store already has
   those IDs. **Lesson:** when running this pipeline against a second or third repo in
   the same week, either namespace task IDs by repo or verify the batch-create
   response actually created N new tasks (not 0) before assuming the new repo's tasks
   were filed.

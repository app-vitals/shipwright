# patch-lean drop audit (DTA-9.6)

Scope: decide what a lean version of `plugins/shipwright/commands/patch.md` (2549 lines) may drop or demote before anyone writes `patch-lean`. Docs-only; no prompt is changed here.

Context: `PLAN.md` (this directory) trims one prompt at a time, with the steps as the product and the "how" as the cut target; DTA-2.2 builds the dev-task variant (spine + `references/`) and DTA-3.1 picks the next prompt. No `dev-task-lean.md` exists in this checkout (`dev-task.content.test.ts` even asserts the string is absent from the dev-task corpus), so the relationship is by plan only: the trial runs `/shipwright:dev-task-lean` via `SHIPWRIGHT_LOOP_DEV_TASK_ALT_COMMAND`. patch-lean should copy the same shape: a spine that carries every step, plus reference files that carry mechanics.

## Guiding lesson

References load in only 2-27% of runs (figure supplied with the DTA-9.6 brief; the measurement itself is not in this repo, so treat it as given, not re-derived). Therefore:

1. Anything that must run on every qualifying run goes in the spine. A step that lives only in a reference is a step that is skipped 73-98% of the time, and adherence is the thing PLAN.md exists to protect.
2. A reference is acceptable only for content that is (a) entered on a mechanical, spine-visible trigger, or (b) context/mechanics that improve quality but whose absence does not skip a step.
3. For a guard, split it: the trigger check and the "stop, do not dispatch" rule stay in the spine; the long matching rules, rationale, payload templates and exact `curl` bodies move to a reference that the spine says to `Read` when the trigger fires.
4. "Drop" is reserved for text that restates something already enforced elsewhere (TypeScript scripts, the orchestrator) or pure incident narrative. Incident narrative is not lost: it stays in `planning/*/PLAN.md` and git history, which this audit cites.

## Summary table

| Item | Section (patch.md lines) | Verdict | One-line reason |
|---|---|---|---|
| CDH-1.2 `.claude/**` escalation | 5a.6b (1144-1228) | Keep in spine (trigger + stop rule); matching fine print and resolve-threads mechanics to reference | Without it the PR loops every tick; inline-thread signal is cheap and must run on every List A pass |
| RPF-1.3 second-round escalation | 5a.7 (1229-1366) | Keep in spine (candidate reply + SAME/DIFFERENT judgment + stop rule); mechanics to reference | Judgment is the guard; a timestamp-only version already caused a false escalation |
| CFE-1.1 existing-escalation skip | 6b.6 (1942-2006) | Keep in spine (two GETs, OR rule, stop) | Cheap; without it CI-fix contradicts a recorded HITL decision every cycle |
| PH-1.1 bundle gate | 6b.7 (2007-2054) | Keep in spine (one GET, stop, skip-reason marker) | Protects the direct-invocation path `check-patch.ts` cannot cover |
| PCC-1.1 rerun-first | 6b.8 (2055-2144) | Keep gate + rerun + bounded poll in spine; duration-context collection to reference | Rerun is a must-run behavior change; duration context is prompt garnish |
| SLS-2.2 out-of-scope CI ledger write | 6b.9 (2145-2175) | Keep in spine | A silent exit without the `ci:` ref re-selects the PR every tick |
| Dependency-risk DBP-1.2 | 3a.5 (489-626) | Move to reference behind a spine trigger (bot author or manifest path touched); drop the "why re-derived" essay | Applies to a minority of PRs, but the already-held exclusion must survive |
| Pre-claim release | 3d (692-723) + marker parse in Step 2 | Keep in spine (6 lines) | Persisted state the run must give back; orchestrator net (PRL-1.3) is a backstop, not a replacement |
| Lane 4 / 5 / 6 shared mechanics | 4a-4d, 5a-5d, 6a-6e | Merge into one shared lane section | ~60% of the three lanes is the same text three times |
| Lane-specific parts | 4b, 5b, 6b-6c | Stay lane-specific, as references | Subagent prompts and lane gates differ |

Nothing is dropped outright except the items listed under "Dropped text" at the end, each with a rationale.

## Incident-driven guards

For each guard: purpose, incident (with evidence source), verdict, reason. "Not found" means a search of `git log -S`/`--grep` for the ID, `planning/`, and `docs/` found nothing.

### CDH-1.2: `.claude/**` path escalation (Step 5a.6b, lines 1144-1228)

- **Purpose.** The Claude Code CLI blocks writes under `.claude/**` unconditionally in headless `-p` runs. A fix subagent dispatched for a finding needing such an edit can never succeed, so the PR would loop through Step 5b every cycle and re-qualify for List A. The check escalates to HITL on the first round (it does not wait for the second round that 5a.7 needs), then resolves all unresolved inline threads so the PR does not re-enter List A.
- **Incident.** app-vitals/shipwright#3366, where the constraint surfaced mid-flight as a review finding. Source: commit `1704c1085` ("escalate .claude/** review findings to HITL on first round in patch.md", #3431) and the section text itself. Sibling commit `15ac02bb2` (#3429) added the planning-time equivalent to plan-session Step 5.5. There is no `planning/*/PLAN.md` for CDH-1.x and no `docs/` page; "not found" beyond the commit message and the section text.
- **Verdict: keep in spine, in compressed form.** Spine: "For each unresolved List A thread, if the first comment's `path` starts with `.claude/`, escalate and skip Steps 5a.7 and 5b." Reference (`guards-escalation.md`): the review-body fallback (backticked `.claude/` path in the same sentence as a remediation verb; ambiguous means do not match), the `{blockedReason}`/`{comment_body}`/slug values, and the resolve-all-threads mutation. The spine carries a mechanical grep trigger ("a review body contains a backticked `.claude/` span") so the fallback reference loads only when it can matter.
- **Why.** The inline-thread signal is the reliable one and costs one string compare per thread, so it must run every time (loading rate is too low to put it in a reference). The fuzzy body-level heuristic is the part that benefits from being a reference.

### RPF-1.3: second-round escalation (Step 5a.7, lines 1229-1366)

- **Purpose.** RPF-1.1/1.2 let a REJECTed finding be rebutted and set `reviewState` back to pending, which re-triggers review. If the fresh review still raises the same finding, the cycle would repeat forever. 5a.7 detects an author reply dated before the current review, judges `SAME_FINDING` or `DIFFERENT_FINDING`, and on `SAME_FINDING` escalates, resolves all open threads, releases the claim, and skips dispatch.
- **Incident.** Original: commit `e83101ec7` (#1946), "escalate to HITL instead of looping on a re-reviewed rebuttal"; planning context in `planning/pr-findings-ledger/PLAN.md` (RPF-1.1's manual `reviewState: "pending"` reset). Rewrite (RPF-1.5): commit `959a34202` (#2275), replacing timestamp-only matching with content correlation after "PR #2153" (named in the step's own text; the repo is not stated there and `git log` for that number in this repo resolves to an unrelated workflow-name change, so the incident PR is in another repo: not found here). That PR had an unrelated earlier rebuttal that predated a new finding, a timestamp-only check escalated instead of fixing, and it repeated after the HITL flag was cleared. First-round BLOCKED escalation is the separate BHE-1.1 (`b4bf2a9b4`, #2231).
- **Verdict: keep in spine; shrink.** Spine keeps: the cheap pre-filter (reply by `PR_AUTHOR` with `createdAt` before the review's `submittedAt`), the mandatory printed `Judgment: SAME_FINDING | DIFFERENT_FINDING` block, the one-line anti-pattern ("timestamp alone never escalates"), and the stop rule. Reference keeps: the blockedReason/comment strings, the thread-resolution mutation, and the inline-thread `path`/`line` correlation guidance.
- **Why.** The printed judgment is a step whose skipping is observable and harmful (it is the exact bug RPF-1.5 fixed). The explanatory prose (about 40 lines contrasting this with `isAddressedByAuthorReply`) is rationale, not procedure, and can be cut to the anti-pattern line.

### CFE-1.1: existing-escalation check before CI-fix (Step 6b.6, lines 1942-2006)

- **Purpose.** Step 5a.7 escalates in List A only. Once its comment exists, CPF-2.3's reply-after-review exclusion drops the PR from List A; if CI is still red, Step 3c puts it in List D and Step 6 would dispatch a CI-fix subagent that contradicts the recorded HITL decision. 6b.6 re-fetches the PR record (`blocked`) and every task on the PR (`hitl == true` or `status == "blocked"`, OR across matches), and if either is set, releases the claim and moves on.
- **Incident.** a downstream repo PR (#3318), "observed re-triggering every patch cycle". Source: commit `6ccf8488c` (#2037). Later hardened by `2b5a4e8a1`/`a49db81ea` (hitl to `status:blocked` migration, HSR-1.1 `5503c8174`). No planning doc: "not found" beyond the commit.
- **Verdict: keep in spine.** About 12 lines: the two `GET`s, the OR rule, the release call, the print line, the stop. The `PR_TASK_ID` it resolves is reused by Step 6d's BLOCKED path, so it is load-bearing for the lane.
- **Why.** It is a pre-dispatch stop. If it sits in a reference that loads 2-27% of the time, 73-98% of CI-fix runs dispatch against an existing HITL decision. Open question for patch-lean (not required): the same check is logically valid for lanes 4 and 5 (a PR with an existing escalation should not be dispatched on in any lane). Hoisting it into the shared claim section would be a behavior change, so the default here is to keep it lane-6-only and flag the hoist for review.

### PH-1.1: bundle completeness gate (Step 6b.7, lines 2007-2054)

- **Purpose.** Re-checks `GET /tasks?branch={branch}` immediately before the CI-fix dispatch; if any bundle-mate is `pending`, `in_progress` or `blocked`, it releases the claim and fully stops with `[silent]` plus `[skip-reason:patch:deferred:bundle-incomplete:{branch}]`. A CI fix pushed over a branch other tasks are still building is wasted or destructive. It covers the human-invoked path that bypasses `check-patch.ts`'s `isBundleComplete` (CPB-1.1) and the race between candidate selection and dispatch.
- **Incident.** a downstream repo PR (#3558) ("where the incident actually happened"). Source: commit `cecfaecd4` (#2546); a follow-up `0d226a945` removed an internal repo name from the prose. No planning doc: "not found".
- **Verdict: keep in spine.** About 10 lines. The skip-reason marker string must stay verbatim in the spine because the admin cron-logs UI keys on it.
- **Why.** It is a pre-dispatch stop on every CI-fix run. A reference load rate of 2-27% makes the gate fail open on most runs. Note the intended behavior (a bundle-held PR is silently skipped) is documented in memory as expected, so a lean prompt must not "fix" it.

### PCC-1.1: rerun-first for cancelled-only CI (Step 6b.8, lines 2055-2144)

- **Purpose.** If the latest List D signal is `cancelled` only (`CI_HAS_CANCELLED` true, `CI_HAS_FAILING` not true), rerun the cancelled run via `gh run rerun`, poll every 15 s up to 8 times (renewing the claim heartbeat each iteration), and skip the fix dispatch if it ends non-failing. Otherwise fall through to 6c with `{repeated-timeout-context}` (job duration versus the typical successful duration).
- **Incident.** PR #2562 (a plan-only PR) sat `BLOCKED` indefinitely because its `lint / typecheck / test` job hit `timeout-minutes: 8` after 13 minutes and GitHub's API reports that as `cancelled`, not `timed_out`. Sources: `planning/patch-cancelled-ci/PLAN.md` (root cause and the unsafe-blanket-fix argument for workflows with `cancel-in-progress`), commit `055f3effd` (#2574), implementation docs in `docs/agent-key-files.md` and refresh `dd3ea7965`. Classification of CI states has since moved into the shared classifier (`37beb6d18`, CIG-1.2; `0bb0e7d66`), so Step 3c is no longer the only place this is decided.
- **Verdict: keep gate, rerun and bounded poll in spine; move the duration-context collection to reference.**
- **Why.** The rerun is a behavior that changes the outcome (it avoids a needless subagent), so it must run whenever the gate holds. The `gh api .../jobs` and `gh run list --workflow` duration probes are explicitly "best-effort ... context for the subagent prompt", so skipping them costs prompt quality only. Put them in the CI lane reference, which is loaded on fall-through.

### SLS-2.2: out-of-scope CI judgment (Step 6b.9, lines 2145-2175)

- **Purpose.** After reading the CI logs, if the failure is not caused by this PR (for example it already fails on the base branch), write a `source: "patch"`, `disposition: "rejected"` ledger entry with ref `ci:{headSha}:{CI_FAILURE_SIGNATURE}`, release the claim, skip 6c-6e, and never end `[silent]` without that entry. A later push changes the head SHA, so the entry stops matching and the PR re-qualifies.
- **Incident.** Another agent reported PRs auto-blocked by the skip streak on 2026-10-08 (16:59-17:56 UTC): inherited-red CI re-selected the PR every tick, patch judged the failure out of scope and exited, and nothing recorded the judgment. Source: `planning/skip-progress-live-state/PLAN.md` (the task table lists SLS-2.2 and its dependency SLS-2.1), commit `8ea869f37` (#4135), and `planning/patch-outcome-hardening/PLAN.md` for the escalation interplay.
- **Verdict: keep in spine.** About 8 lines including the ref format and the "never exit `[silent]` without it" rule. The `curl` body can live in the CI-lane reference, but the spine must say that a ref is written and what its shape is.
- **Why.** The failure mode is a silent exit with nothing recorded, which is invisible to outcome metrics. It needs `CI_FAILURE_SIGNATURE` from 6b (line 1885), so the lean 6b collection step must keep that computation in the spine.

### Dependency-risk detection, DBP-1.2 (Step 3a.5, lines 489-626)

- **Purpose.** Derives a `{recommendation, flags, reasoning}` finding from the PR's own diff (`resolve-dependency-watched-paths.ts` plus `references/dependency-risk-analysis.md`), routes `hold`/`review` into List A (otherwise a clean `Verdict: APPROVE` keeps a dependency-only PR out of List A forever), excludes an already-held finding at the same head via ledger ref `dependency-risk@{headRefOid}`, and gates Step 5b's DEPENDENCY-RISK REMEDIATION PROTOCOL.
- **Incident.** a downstream repo PR (#5121), a Renovate js-yaml v4 to v5 bump with a transitive-dependency clash invisible to CI; three patch claims over about three hours each skipped with no commit. Sources: `planning/dependency-patch-flow/PLAN.md`, commits `f8be7f284`/`92d277517` (#3235), which also added the List A routing fix.
- **Verdict: move to a reference with a spine trigger.** Spine (about 6 lines): "If `PR_AUTHOR` is a Renovate/Dependabot bot, or the changed files include a package manifest or lockfile, Read `references/patch-lean/dependency-risk.md` and apply it before building the lists." Reference: derivation, routing, the already-held exclusion (this is the Independence Principle #6 idempotency fix and must be kept whole), and the protocol gate. Drop the "Why this is re-derived" essay (about 14 lines, lines 613-626) to a two-line note.
- **Why.** Most PRs are not dependency bumps, so unconditional spine cost is waste; the trigger is a superset of the watched-path test (false positives only load a reference). The exclusion must not be thinned, since without it the same rebuttal is re-posted every cycle.
- **Risk.** Step 5b's protocol block and Step 5c's `dependency-risk@` ref pass-through depend on this step; the lean lane reference for findings must carry the same cross-reference or the exclusion silently stops matching.

### Pre-claim release (Step 3d, lines 692-723; marker parse in Step 2)

- **Purpose.** If `PRECLAIM_RECORD_ID` was parsed from the orchestrator's `[preclaim:{recordId}:{commitSha}]` marker, release it by record id when all three lists are empty and the run exits `[silent]`, because that exit precedes every claim site that would adopt or release it. Failure is non-fatal.
- **Incident.** `planning/patch-prose-lock-release/PLAN.md`: the empty-lists exit held the pre-claim (CBD-1.3) until TTL expiry, after which the PR was re-dispatched; with PHS-3.1 that cycling got PRs blocked as "no progress". Tasks PRL-1.2 (the prose release, in commit `455c36d30`, #4153, together with PRL-1.1) and PRL-1.3 (orchestrator safety net, `e18586b80`, #4154).
- **Verdict: keep in spine** (about 6 lines, one `if` + `curl`).
- **Why.** PRL-1.3 makes the orchestrator release a still-held pre-claim after a silent dispatch, so dropping the prose would be survivable, but the plan deliberately chose two layers ("precise release at Step 3d (prose) and a mechanical safety net"). Six lines is cheap, and the prose release is the only one that works for a human-invoked or non-orchestrated run. Revisit only if the orchestrator net is shown to cover every exit. The `[skip-reason:patch:deferred:no-op-at-dispatch:{pr}]` marker emitted in the same block also stays.

## Near-duplicate lanes (Steps 4, 5, 6)

The three lanes are structurally the same: set up a worktree, detect the toolchain, claim the PR record, dispatch one subagent, handle its STATUS, upsert the PR record, clean up. Evidence from the text: 6a opens with "Same pattern as Step 5a"; 4a.5, 5a.5 and 6a.5 are the same five-step toolchain procedure (differing only in "Step 4b/5b/6c" in the lint-scoped sentence); the three claim sections repeat the same Pre-Claim Fast Path (CBD-1.5) and 409 handling; each "Step N-c" BLOCKED branch repeats the same escalation call with different strings; and each dispatch begins with the same heartbeat renewal and the same `PATCH_SUBAGENT_TYPE`/`PATCH_MODEL` sentence.

### What merges into one shared lane section

| Shared piece | Currently | Merged form |
|---|---|---|
| Worktree setup and removal-if-exists | 4a (737-757), 5a (1028-1044), 6a (1823-1837) | One block with `{lane}` unused; branch slug rule once |
| Toolchain detection and scoped lint | 4a.5, 5a.5, 6a.5 (about 25 + 49 + 25 lines; 5a.5 also lists the fix inputs) | One "detect toolchain" paragraph pointing at `references/toolchain-patterns.md`; the lane names the step that consumes `{lint command}` |
| Claim with Pre-Claim Fast Path and 409 skip | 4a.6, 5a.6, 6b.5 | One block; per-lane difference is only the "next candidate" sentence |
| Heartbeat then dispatch via `PATCH_SUBAGENT_TYPE` with `model: PATCH_MODEL`, `run_in_background: false` | start of 4b, 5b, 6c | One sentence; lanes supply only the prompt |
| STATUS handling skeleton: no parseable STATUS (Step 2.2 retry), DONE, DONE_WITH_CONCERNS, BLOCKED | 4c, 5c, 6d | One table; the BLOCKED branch becomes "escalate via `escalation-pattern.md` with this lane's `{blockedReason}`, `{comment_body}`, slug (`blocked-4c`/`blocked-5c`/`blocked-6d`)" |
| Upsert PR record (heartbeat, `HEAD_SHA_POST_PATCH`, `POST /prs/:id/patch`) | 4c.5, 5c.5, 6d.5 | One block; 5c.5 adds the findings ledger write, 6d.5 adds `ciFailureSignature` |
| Worktree cleanup | 4d, 5d, 6e | One line |
| Claim release on skip paths | repeated inside 5a.6b, 5a.7, 6b.6, 6b.7, 6b.8, 6b.9 | One "release the claim" snippet referenced by name from each guard |

The spine holds the merged skeleton as one ordered list (about 40 lines in the budget below), not as a reference, because claim, dispatch, status handling and upsert must run every time a lane fires.

### What stays lane-specific

- **Lane 4 (conflicts).** The 4b dispatch prompt (merge base, resolve, validate, push), plus its status text. No pre-dispatch guards. Reference: `lane-conflicts.md`.
- **Lane 5 (findings).** The 5b prompt with Instructions [A]-[E] (classify ACCEPT/MODIFY/REJECT, rebut with `gh pr comment`, resolve threads), the input assembly (unresolved threads, review bodies, `filter-bot-comments.ts` output), 5c's REJECT bookkeeping (`REJECTED_FINDINGS_THIS_CYCLE`, settle-with-rejected, PHS-2.1), 5c.5's findings ledger write, the CDH-1.2 and RPF-1.3 guards, and the dependency-risk protocol block. Reference: `lane-findings.md` plus `guards-escalation.md`.
- **Lane 6 (CI).** 6b log collection and `CI_FAILURE_SIGNATURE`, the CFE-1.1/PH-1.1/PCC-1.1/SLS-2.2 guards, the 6c prompt, 6d.5's `ciFailureSignature` field, and the 6.5 verify-CI poll with its single bonus CI-fix subagent. Reference: `lane-ci.md`, `guards-ci.md`, `verify-ci.md`.

Ordering that must be preserved in the spine: lane 4 then 5 then 6; within lane 5, claim then 5a.6b then 5a.7 then dispatch; within lane 6, claim then 6b.6, 6b.7, 6b.8, 6b.9 then dispatch.

## Size budget

Spine: `plugins/shipwright/commands/patch-lean.md`, hard limit 150 lines. References live under `plugins/shipwright/commands/references/patch-lean/` (new). Existing shared references (`escalation-pattern.md` 99 lines, `toolchain-patterns.md`, `dependency-patch.md`, `dependency-risk-analysis.md`) are reused unchanged and are not counted against the 2549.

### Proposed files

| File | Budget (lines) | Contents | Loaded when |
|---|---|---|---|
| `patch-lean.md` (spine) | <=150 (target 146) | Frontmatter, args/target gate, own-login and author-scope check, list classification via scripts, pre-claim release, merged lane skeleton, guard triggers (CDH-1.2, RPF-1.3, CFE-1.1, PH-1.1, PCC-1.1, SLS-2.2), dependency trigger, 6.5 verify and Step 7 report | Always |
| `model-resolution.md` | 70 | Steps 2.1 (MTR-2.1 tier) and 2.2 (PTM-1.2 configured subagent, unparseable-dispatch handling) | Only when an override is configured or dispatch fails to parse |
| `classification.md` | 90 | 3a query and script usage, 3b, 3c CI states, BEHIND/DIRTY handling of 2.5 | When a list is ambiguous or a rebase is needed |
| `dependency-risk.md` | 70 | 3a.5 derivation, routing, already-held exclusion | On the spine's bot/manifest trigger |
| `lane-shared.md` | 130 | Full text for worktree, toolchain, claim, heartbeat, status handling, upsert, cleanup | First time a lane fires; spine carries the one-line versions |
| `lane-conflicts.md` | 60 | 4b conflict-resolution prompt | Lane 4 |
| `lane-findings.md` | 190 | 5b prompt [A]-[E], input assembly, 5c REJECT/settle bookkeeping, 5c.5 ledger write | Lane 5 |
| `lane-ci.md` | 110 | 6b collection and signature, 6b.8 duration context, 6c prompt, 6d.5 | Lane 6 |
| `guards-escalation.md` | 110 | CDH-1.2 fallback and strings, RPF-1.3 correlation and strings, shared thread-resolution mutation, CFE-1.1 variable notes | When a guard trigger fires |
| `guards-ci.md` | 70 | PH-1.1 and SLS-2.2 `curl` bodies, PCC-1.1 poll loop detail | When a lane-6 guard fires |
| `verify-ci.md` | 50 | 6.5a polling, 6.5b bonus subagent, Step 7 report template | After any push |
| **Total** | **1096** (146 + 950) | | |

Overall: 2549 to about 1096 lines (about 57% fewer). Spine plus the always-needed shared mechanics is 146; the remaining 950 are loaded on triggers. The spine target is 146 so it stays under 150 with slack for the frontmatter.

### Spine allocation (146)

| Block | Lines |
|---|---|
| Frontmatter, intro, autonomy note, task-store setup note | 12 |
| Steps 0-2 (target gate, login, PR resolve, author scope, preclaim marker parse) | 18 |
| Step 2.5 BEHIND/DIRTY one-liners | 8 |
| Step 3 classification via scripts, dependency trigger, 3d empty-lists exit with pre-claim release and skip-reason | 26 |
| Merged lane skeleton (setup, toolchain, claim, dispatch, status, upsert, cleanup) | 40 |
| Guard triggers: CDH-1.2, RPF-1.3, CFE-1.1, PH-1.1, PCC-1.1, SLS-2.2 (about 5 lines each) | 30 |
| Step 6.5 verify and Step 7 report one-liners | 12 |
| **Total** | **146** |

### Current accounting (sums to 2549)

| Current block | Lines | Destination |
|---|---|---|
| Preamble, Arguments, Steps 0, 1, 2 (1-156) | 156 | Spine (18 + 12) |
| Steps 2.1, 2.2 (157-306) | 150 | `model-resolution.md` |
| Step 2.5 (307-347) | 41 | Spine (8) + `classification.md` |
| Step 3 / 3a (348-488) | 141 | `classification.md` + spine |
| Step 3a.5 (489-626) | 138 | `dependency-risk.md` |
| Steps 3b-3d (627-736) | 110 | `classification.md` + spine (3d) |
| Step 4 (737-1022) | 286 | `lane-shared.md`, `lane-conflicts.md` |
| Step 5 through 5b (1023-1661) | 639 | `lane-findings.md`, `guards-escalation.md` (5a.6b + 5a.7 = 223 lines), `lane-shared.md` |
| Steps 5c-5d (1662-1816) | 155 | `lane-findings.md`, `lane-shared.md` |
| Step 6 (1817-2402) | 586 | `lane-ci.md`, `guards-ci.md`, spine guards (6b.6-6b.9 = 234 lines) |
| Step 6.5 (2403-2512) | 110 | `verify-ci.md` |
| Step 7 (2513-2549) | 37 | Spine + `verify-ci.md` |
| **Total** | **2549** | |

Budgets are targets, not measurements; lane-findings (190) is the largest reference because Step 5b alone is 295 lines today and carries the most prompt-level "how". If the 190 target proves too tight in review, trade it against `lane-shared.md`, not the spine.

## Dropped text (with rationale)

| Text | Lines (approx) | Rationale |
|---|---|---|
| "Why this is re-derived rather than parsed off a prior review" essay in 3a.5 | 613-626 (14) | Pure design rationale; the two-line conclusion ("re-derive from the diff; the posted clause lacks `flags`") is kept in `dependency-risk.md`. Evidence remains in `planning/dependency-patch-flow/PLAN.md` |
| Step 3d "Design note" about why candidacy needs no write-back | 716-723 (about 8) | Rationale for not building something; the actionable part (release the pre-claim) is kept. History in `planning/patch-prose-lock-release/PLAN.md` |
| Rationale paragraphs in 5a.7 contrasting with `isAddressedByAuthorReply` and re-narrating PR #2153 | about 40 of 138 | The anti-pattern is retained as one line; the full story is in commits `e83101ec7`, `959a34202` |
| Repeated "no fresh fetch / reused from Step 2.1" bullets in each escalation site | about 6 sites x 3 lines | Replaced by one statement in `escalation-pattern.md` (it already says `PR_TASK_ID` is resolved by the caller) |
| Duplicate toolchain text in 5a.5 and 6a.5 | about 74 | Identical to 4a.5 modulo step numbers; merged, not lost |

No guard in the incident-driven list is dropped. The only guard-adjacent drop candidate, the PRL-1.2 prose release, is kept because the orchestrator net (PRL-1.3) is a second layer by design, not a substitute.

## Risks and follow-ups for the patch-lean author

1. Every guard in the spine needs a content test equivalent to `patch.content.test.ts` (the current guards are asserted there); update it to read the spine plus the references in the same way the dev-task tests read `corpusOnly()`.
2. Step order inside lanes 5 and 6 is behavior. A shared skeleton must not let the model reorder guards after dispatch.
3. `PR_TASK_ID` is resolved in 2.1 and again in 6b.6 (first matched task, different from 2.1's highest-tier choice). Keep both semantics or reconcile them deliberately; `escalation-pattern.md` documents the difference.
4. Adherence for patch is not yet measurable: `required-steps/` only has a dev-task table (DTA-2.1). Add a patch table (guard pass-through is observable via the `[skip-reason:...]` markers and ledger writes) before trialing, otherwise a lean patch could silently skip a guard exactly as dev-task skipped Step 5.
5. The CFE-1.1 hoist to all lanes and a shared `ciFailureSignature` source are behavior changes and are deliberately not part of "lean"; track them separately.

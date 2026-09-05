# Dependency Patch Remediation

Bounded remediation for a dependency-bump PR that a risk analysis has already flagged as
needing attention. This reference consumes the `{recommendation, flags, reasoning}` shape
produced by [`dependency-risk-analysis.md`](./dependency-risk-analysis.md) — that reference
decides *whether* a dependency bump is risky; this one decides *what, if anything, to do
about it* inside the PR's own worktree. It has no opinion on how the caller obtained the
risk analysis result, how it fetched the PR into a worktree, how it reports the outcome, or
how/whether it escalates to a human — those are the calling skill's concerns, not this
reference's.

## Inputs

- **`recommendation`** — the `merge` / `review` / `hold` verdict produced by
  `dependency-risk-analysis.md`. Remediation is typically only invoked for a `review` or
  `hold` recommendation — a `merge` recommendation has, by definition, nothing to remediate.
- **`flags`** — `breakingChange`, `securityRelevant`, `productionImpact` (booleans), from the
  same analysis result. `breakingChange` is the flag most directly relevant here: it signals
  that the failure this reference is being asked to fix is likely a genuine breaking
  API/behavior change in the bumped package, not a transient flake.
- **`reasoning`** — the free-text explanation from the risk analysis. Critically, this is
  expected to name (or make directly derivable) a **verification command** — the test,
  build, or lint invocation that demonstrates the breaking change in practice (e.g. "`bun
  test` fails with `TypeError: x.oldMethod is not a function`", or "`cargo build` fails: `no
  method named 'foo' found for struct 'Bar'`"). The reproduce-before-fixing protocol below
  depends on this command being nameable — see the no-safe-strategy exit for what happens
  when it isn't.
- **the PR's worktree** — a local checkout of the dependency-bump PR's branch, with the
  lockfile/manifest bump already applied.
- **the PR's diff** — the actual dependency version bump(s) in the PR, for identifying
  exactly which package(s) moved and by how much.

## Output

- **`outcome`** — one of `fixed` / `held` (exactly one per remediation attempt).
- **`actions`** — free text describing what was actually changed (which catalog strategy was
  applied, and to which file(s)) when `outcome` is `fixed`; empty/absent when `held`.
- **`verificationCommand`** — the command identified from `reasoning`, run to reproduce the
  failure and re-run to confirm the fix — recorded verbatim so the caller can show its exact
  output rather than a paraphrase.
- **`reasoning`** — free text explaining why the outcome was reached: either what the fix did
  and how it was confirmed, or exactly why no in-catalog strategy applied, or why the failure
  could not be reproduced or verified.

## Reproduce-before-fixing protocol

**Never attempt a fix before reproducing the failure.** Before touching any code:

1. Extract the verification command named (or directly derivable) from `reasoning`.
2. Run it, unmodified, in the PR's worktree — exactly as `dependency-risk-analysis.md`'s
   `reasoning` described it, not a substitute or "equivalent" command.
3. Confirm it fails the same way `reasoning` describes. If it does not fail — it passes
   cleanly, or fails with a different, unrelated error — the finding is not reproducible
   here and now. Do not guess at a fix for a failure you cannot see; exit via the
   no-safe-strategy exit below.

Only once the failure is reproduced locally, exactly as described, does the remediation
strategy catalog below apply.

**After applying a fix, re-run the same verification command before claiming anything
fixed.** The exact command run in step 2 above — not a different or "equivalent" one — must
be re-run after the fix, and it must pass. If it still fails, the fix did not work: do not
report `outcome: fixed`. Treat a fix that doesn't clear re-verification exactly like an
unreproducible failure, and exit via the no-safe-strategy exit below rather than reporting a
fix the verification command itself contradicts.

## Remediation strategy catalog

This catalog is **bounded** — exactly two strategies are in scope. Nothing outside this list
is attempted by this reference, no matter how plausible it looks:

1. **Transitive-dependency override / resolution pin.** When the reproduced failure comes
   from a *transitive* dependency (not the package the PR directly bumps) landing at a bad
   version, pin it to a known-good version via the ecosystem's override mechanism — e.g.
   npm/Yarn's `overrides` or `resolutions` field in `package.json`, a Cargo `[patch]`
   section, or the equivalent resolution-pin mechanism for the project's toolchain. This
   strategy never touches application code — only the dependency-resolution manifest and its
   lockfile.
2. **Removed/renamed first-party API call-site update.** When the reproduced failure is a
   removed or renamed API in the *directly* bumped package, update the codebase's own call
   site(s) to match the new API shape — e.g. renaming a method call, adjusting an import
   path, or updating an argument list at each affected call site. This is a small, mechanical,
   targeted call-site update scoped exactly to what the verification command's failure
   names — not a broader refactor of surrounding code.

## No-safe-strategy exit

Anything outside the two catalog strategies above — and any claim that is unreproducible or
unverifiable — exits to **leave as hold** rather than attempting a speculative fix. Do not
fabricate a fix when the failure can't be reproduced, and do not report a fix that the
re-run verification command doesn't actually confirm.

Concretely, leave as hold when any of the following is true:

- The verification command from `reasoning` does not reproduce the described failure (an
  **unreproducible** claim — see the reproduce-before-fixing protocol above).
- The reproduced failure requires a change outside the bounded catalog above — e.g. a
  genuine breaking-behavior migration in application logic, a config schema change, a data
  migration, or anything requiring judgment calls the catalog's two mechanical strategies
  don't cover.
- A fix was attempted from the catalog, but the re-run verification command still fails
  afterward — an **unverifiable** fix, meaning the attempted fix did not actually resolve
  the failure.

In every one of these cases, report `outcome: held` with `reasoning` explaining exactly
which condition applied, and stop — do not retry with a different guess, and do not report
`outcome: fixed` on anything less than a passing re-run of the exact verification command
identified at the start.

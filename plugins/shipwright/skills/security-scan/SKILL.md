---
name: security-scan
description: Scan a repo for secrets, dependency CVEs, container CVEs/SBOM, GitHub Actions issues, authn/authz anti-patterns, and posture gaps across three tiers. Report only — no code changes.
---

# Security Scan

Run a report-only, three-tier security scan against a single checked-out repo and write a
structured report plus a cross-run ledger. This skill makes **no code changes** — it reads,
runs read-only tools, and reports only. A companion `/security-fix` skill (not this one) acts
on the findings.

The three tiers are:

- **Tier 1 — real binaries.** Pinned-version, sha256-verified downloads of `gitleaks` (secret
  scan, full history), `osv-scanner` (lockfile CVEs), `grype` + `syft` (container CVE scan +
  SBOM generation), and `zizmor` (GitHub Actions workflow lint). Each tool has an explicit
  per-tool fallback — if its download or checksum step fails, that one tool's findings are
  skipped, the gap is noted in the report, and the scan continues. **A single tool's download
  failure must never fail or abort the whole scan.**
- **Tier 2 — LLM-driven checks.** Judgment-based Read/Grep passes for authn/authz
  anti-patterns and hardcoded credentials not caught by gitleaks. No binaries.
- **Tier 3 — posture checks.** Presence checks for `SECURITY.md`, an SBOM artifact (from
  Tier 1's syft output), and branch-protection status.

> **Trivy is deliberately excluded.** Trivy is a very common container/SBOM scanner, so its
> absence here is intentional and worth documenting: Trivy suffered a supply-chain compromise
> in March 2026 (advisory **GHSA-69fq-xp46-6x23**). Until that is fully resolved and
> re-audited, this skill uses **Grype + Syft** (both Anchore projects) instead for container
> CVE scanning and SBOM generation. Do not reintroduce Trivy here without an explicit
> security review.

---

## Setup: Parse Arguments

Before starting, check if any flags were passed:

- `--init` — copy the default security-scan principles file to the project and exit (no scan)
- `--summary` — print counts to stdout; skip writing `security-report.md`
- `--dry-run` — run the full scan (tool downloads, Tier 2/3 checks, diffing) but skip writing
  `security-report.md` **and** skip updating `state/security-patrol-ledger.json`. Print
  everything that would have been written to stdout instead.

---

## Step 1: Handle `--init` Flag

If the `--init` flag was passed:

1. Check if `.claude/shipwright/security-principles.md` already exists in the project root.
   - If it exists, print: "Config already exists at `.claude/shipwright/security-principles.md`. Edit it to customize security checks for this project." and stop.
2. If it does not exist, create the directory and copy the default principles file:
   - Source: `references/principles.md` (relative to the plugin root — the plugin's own shared security principles file)
   - Destination: `.claude/shipwright/security-principles.md` in the project root
3. Print: "Created `.claude/shipwright/security-principles.md`. Edit it to customize security checks for this project. Re-run `/security-scan` to start scanning."
4. Stop — do not run the scan.

---

## Step 2: Detect Repo + Derive `repo-slug`

Detect the current repo from git: run `git remote get-url origin` and strip the
`https://github.com/` (or `git@github.com:`) prefix and the `.git` suffix to get the
`org/repo` value — e.g. `app-vitals/shipwright`.

Derive `repo-slug` from it: **the last path segment, lowercased** — e.g.
`app-vitals/shipwright` → `shipwright`. (This mirrors the `repo-slug` derivation used by
`entropy-fix`, `test-fix`, and `consolidation-fix`.) Compute this once here and reuse it for
every ledger key and finding ID below.

**Why this matters (critical):** ledger keys and per-finding IDs are namespaced as
`security-{rule}-{repo-slug}-{YYYY-Www}` — rule + **repo-slug** + ISO week — **not** just
`{rule}-{YYYY-Www}`. This avoids the known `entropy-fix` task-ID **collision** bug: when an
ID is built from rule + week only (no repo component), the same rule firing in two different
repos in the same ISO week produces an identical ID, and the second repo's run silently
no-ops because the ID already exists from the first repo. The `{repo-slug}` component keeps
IDs unique per repo so same-week multi-repo runs never collide.

Compute the ISO week as `YYYY-Www` (e.g. `2026-W29`) from the current UTC date.

---

## Step 3: Tier 1 — Real Binary Tools (pinned + sha256-verified)

Each tool below follows the **exact same pinned-version + sha256sum-verify + extract pattern**
as `.github/workflows/ci.yml`'s existing gitleaks step:

```
curl -sSfL "<pinned release asset URL>" -o <archive>
echo "<sha256>  <archive>" | sha256sum -c
tar -xz -f <archive> <binary>   # (or chmod +x for a bare binary)
./<binary> <read-only scan command>
```

**Per-tool fallback (applies to every tool in this step):** wrap each tool's
download+checksum in its own guarded block. If the `curl` download **or** the `sha256sum -c`
verification fails for a specific tool, do **not** abort the scan. Instead:

1. Skip only that tool's findings.
2. Add a note to the report's "Skipped tools" section, e.g.
   `gitleaks: download failed, skipped — see error above`.
3. Continue with the remaining tools.

The overall scan must **never fail** just because one tool's binary couldn't be fetched or
verified.

**Stage tool binaries outside the scan target.** Before Step 3.1's gitleaks download, create
one staging directory for all five tools' downloads and reuse it for the rest of Step 3:

```bash
TOOLS_DIR="$(mktemp -d)"
```

Every tool's `curl -o`, `tar -xz -f ... -C`, `chmod +x`, and binary-invocation path below uses
`$TOOLS_DIR` — never a bare filename in the repo root. This matters because grype's and
syft's `dir:.` scans (Step 3.3/3.4) walk the **entire** repo-root filesystem tree. If a tool's
own downloaded archive/binary is sitting in the repo root when `dir:.` runs, grype's binary
classifier detects that binary's own embedded Go module info (e.g. `github.com/anchore/syft`,
`github.com/google/osv-scalibr`, `github.com/go-git/go-git`) and reports CVEs against it as if
it were repo code — self-pollution that has inflated raw grype match counts by 10-20x in past
runs. Staging every tool's download in `$TOOLS_DIR` (outside the repo root, and never itself a
scan target) fixes this at the root for all five tools at once, including gitleaks/osv-scanner/
zizmor's binaries, which also currently land in the repo root before grype/syft run. The
`--exclude './node_modules/**' --exclude './worktrees/**'` flags on grype/syft (Step 3.0) are
unrelated environment-noise fixes and stay as-is — grype/syft still scan `.` (the real repo
root); only the tool binaries' own location moves.

> **Checksum provenance.** All five checksums below were independently verified — downloaded
> and hashed locally, then cross-checked against each vendor's published manifest
> (`gitleaks`: `ci.yml`'s existing value; `osv-scanner`: `osv-scanner_SHA256SUMS`; `grype` /
> `syft`: `{tool}_{version}_checksums.txt`; `zizmor`: no vendor checksums.txt is published for
> this release, so its digest is GitHub's own release-asset SHA256, confirmed by an
> independent local download+hash). Whenever a pinned version is bumped, the new checksum
> **must** be re-verified the same way — download the asset, `sha256sum` it locally, and
> cross-check against the vendor's manifest where one exists. Never substitute a
> plausible-looking but unverified hash. If a tool's checksum cannot be verified, treat that
> tool as unavailable and use its per-tool fallback rather than shipping a fake hash.

### 3.0 Exclude Scan-Environment Noise (before running any tool below)

Two non-codebase environment artifacts have repeatedly caused **false-positive** grype-cve /
osv-cve noise across weekly scans: a stale `node_modules/` left over from a previously-fixed
dependency pin, and a leftover `worktrees/` side-checkout nested inside the repo root (e.g.
from a worktree created with a relative instead of absolute target path). Neither is
codebase content — both must be excluded from every Tier 1 scan target so environment
staleness never masquerades as a new/regressed finding:

- **grype and syft** (`dir:` mode) do not respect `.gitignore` at all — they walk the full
  filesystem tree under the given path. Both accept repeatable `--exclude <glob>` flags
  (verified independently by running each tool against a fixture with a lockfile nested
  under `node_modules/` and `worktrees/` — the flag suppresses matches from both without
  affecting real source paths). Always pass:
  ```
  --exclude './node_modules/**' --exclude './worktrees/**'
  ```
- **osv-scanner** has no `--exclude`/path-scoping flag. It does, however, respect git's
  ignore rules by default (no `--no-ignore` passed) — but only for paths git itself
  considers ignored, and a target repo's own tracked `.gitignore` may not cover a top-level
  `worktrees/` directory (a repo's `.gitignore` may only cover a nested worktree convention
  path, missing the top-level one). Rather than depend on the target repo's own `.gitignore`
  contents, add scan-local entries to `.git/info/exclude` — git's per-checkout, untracked
  ignore file — before running osv-scanner:
  ```bash
  grep -qxF 'node_modules/' .git/info/exclude 2>/dev/null || echo 'node_modules/' >> .git/info/exclude
  grep -qxF 'worktrees/' .git/info/exclude 2>/dev/null || echo 'worktrees/' >> .git/info/exclude
  ```
  This is **not the tracked `.gitignore`** and **not a git operation** in the sense of this
  skill's "no git operations" constraint below — it writes local, untracked git metadata,
  not a commit, branch, or staged change, and never touches the working tree or history.
- **gitleaks** is unaffected: its full-history scan (Step 3.1) walks committed git objects,
  not the working tree, so untracked `node_modules/`/`worktrees/` directories never appear
  in its results.

### 3.1 gitleaks — secret scan (full history)

Unlike `ci.yml` (which runs `--no-git` on the working tree), this skill runs a **full-history**
secret scan so secrets committed and later removed are still caught.

```bash
curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v8.27.2/gitleaks_8.27.2_linux_x64.tar.gz" -o "$TOOLS_DIR/gitleaks.tar.gz"
echo "141c3b2dede46d8b3a53b47116da756bd223decc0374797559a6b50ecba5590c  $TOOLS_DIR/gitleaks.tar.gz" | sha256sum -c
tar -xz -f "$TOOLS_DIR/gitleaks.tar.gz" -C "$TOOLS_DIR" gitleaks
"$TOOLS_DIR/gitleaks" detect --source . --redact --report-format json --report-path gitleaks-report.json
```

(Full-history mode: run `gitleaks detect` **without** `--no-git` so it walks the git log.)
Record each finding in the common finding-record shape (Step 6).

> **Suppression via `.gitleaksignore`.** This invocation auto-discovers and respects a
> `.gitleaksignore` file at the scan source root (gitleaks natively defaults
> `-i`/`--gitleaks-ignore-path` to `.` — no flag change is needed). Entries in
> `.gitleaksignore` use the fingerprint format `commit:file:rule:startLine`. Suppression
> entries are only added when a human confirms a false-positive finding while closing a HITL
> task via `/shipwright:hitl` (see GLB-2.2), never automatically.

### 3.2 osv-scanner — lockfile / dependency CVEs

osv-scanner ships a bare linux amd64 binary named `osv-scanner_linux_amd64` (no version in
the filename) plus a `osv-scanner_SHA256SUMS` manifest per release.

```bash
grep -qxF 'node_modules/' .git/info/exclude 2>/dev/null || echo 'node_modules/' >> .git/info/exclude
grep -qxF 'worktrees/' .git/info/exclude 2>/dev/null || echo 'worktrees/' >> .git/info/exclude

curl -sSfL "https://github.com/google/osv-scanner/releases/download/v2.0.2/osv-scanner_linux_amd64" -o "$TOOLS_DIR/osv-scanner"
echo "3abcfd7126c453a00421487e721b296e0cb68085bd431d6cef60872774170fc8  $TOOLS_DIR/osv-scanner" | sha256sum -c
chmod +x "$TOOLS_DIR/osv-scanner"
"$TOOLS_DIR/osv-scanner" scan --recursive --format json --output osv-report.json .
```

> **osv-cve is authoritative for Bun-lockfile dependency CVEs.** For repos using `bun.lock`,
> treat **osv-scanner's `osv-cve` findings as the authoritative dependency-CVE source**, not
> grype's `grype-cve` findings on lockfile-derived (npm/bun) packages. Confirmed root cause:
> syft's package cataloger and grype's own embedded lockfile reader both only **partially parse**
> this org's `bun.lock` format — a generated `sbom.cyclonedx.json` had **zero**
> `pkg:npm/` entries despite hundreds of packages actually present in the lockfile across
> multiple repos scanned, and grype's lockfile reader itself extracted only 2-5 packages out of
> hundreds. osv-scanner's dedicated `bun.lock` parser is comprehensive by comparison (dozens of
> unique CVEs found vs. grype's 1-2 packages in the same runs). Until upstream syft/grype
> `bun.lock` support improves, any `grype-cve` finding on an npm/bun package is a narrow,
> **non-independent subset** of osv-scanner's results — it does **not** corroborate or add
> confidence beyond what osv-cve already reports; absence of a matching grype-cve finding
> means nothing about a real CVE's presence, since grype is undercounting, not disagreeing.

### 3.3 grype — container / filesystem CVE scan

Anchore projects publish `grype_{version}_linux_amd64.tar.gz` plus a
`grype_{version}_checksums.txt` manifest per release.

```bash
curl -sSfL "https://github.com/anchore/grype/releases/download/v0.116.0/grype_0.116.0_linux_amd64.tar.gz" -o "$TOOLS_DIR/grype.tar.gz"
echo "40aff724297312f91ea390d003bed8d8651c74cc7f5b26732db80b3a408d2fc5  $TOOLS_DIR/grype.tar.gz" | sha256sum -c
tar -xz -f "$TOOLS_DIR/grype.tar.gz" -C "$TOOLS_DIR" grype
"$TOOLS_DIR/grype" dir:. --exclude './node_modules/**' --exclude './worktrees/**' -o json --file grype-report.json
```

### 3.4 syft — SBOM generation

Syft is the second Anchore project; same asset/checksum naming as grype
(`syft_{version}_linux_amd64.tar.gz` + `syft_{version}_checksums.txt`). Syft's SBOM output
feeds Tier 3's SBOM-presence posture check.

```bash
curl -sSfL "https://github.com/anchore/syft/releases/download/v1.27.1/syft_1.27.1_linux_amd64.tar.gz" -o "$TOOLS_DIR/syft.tar.gz"
echo "c2cb5867a238baf41adf15f7e01e28cbd886378859eed81e52c080ca0346eefe  $TOOLS_DIR/syft.tar.gz" | sha256sum -c
tar -xz -f "$TOOLS_DIR/syft.tar.gz" -C "$TOOLS_DIR" syft
"$TOOLS_DIR/syft" dir:. --exclude './node_modules/**' --exclude './worktrees/**' -o cyclonedx-json=sbom.cyclonedx.json
```

The generated `sbom.cyclonedx.json` is the SBOM artifact Tier 3 checks for. Note: this SBOM's
package cataloger currently produces **zero** `pkg:npm/` entries for Bun-lockfile repos (see
the osv-cve authority note in Step 3.2) — it is complete for container/filesystem CVE-scan
posture purposes, but is not a reliable source for enumerating npm/bun dependencies.

### 3.5 zizmor — GitHub Actions workflow lint

zizmor is a Rust/cargo-dist project; it moved from `woodruffw/zizmor` to the `zizmorcore/zizmor`
org, and its linux release asset is `zizmor-x86_64-unknown-linux-gnu.tar.gz` (no version in
the filename, and the tarball contains the `zizmor` binary directly — no subdirectory to
strip). No vendor `checksums.txt` is published for this release; GitHub computes and exposes
a SHA256 digest for each release asset, which was independently confirmed by downloading the
asset and hashing it locally.

```bash
curl -sSfL "https://github.com/zizmorcore/zizmor/releases/download/v1.27.0/zizmor-x86_64-unknown-linux-gnu.tar.gz" -o "$TOOLS_DIR/zizmor.tar.gz"
echo "277f2bd8fd37cf60c42ab7afca6faa884e65440fa31e02b44bdaae60f62a358f  $TOOLS_DIR/zizmor.tar.gz" | sha256sum -c
tar -xz -f "$TOOLS_DIR/zizmor.tar.gz" -C "$TOOLS_DIR" zizmor
"$TOOLS_DIR/zizmor" --format json .github/workflows/ > zizmor-report.json
```

If the repo has no `.github/workflows/` directory, record "no workflows to scan" — not a
failure.

---

## Step 4: Tier 2 — LLM-Driven authn/authz + Hardcoded-Credential Checks

These are judgment-based Read/Grep passes — no binaries. Keep this tier lightweight: Grep and
Read for common anti-patterns that Tier 1's tools do not catch, and record each finding in the
same finding-record shape (Step 6).

1. **authn/authz (authorization) anti-patterns.** Look for sensitive routes/handlers missing
   an authorization check, role/permission checks that are commented out or trivially bypassed,
   and weak/timing-unsafe comparison of secrets or tokens (e.g. `==` / `===` on a secret
   instead of a constant-time compare). Read the surrounding handler to confirm the check is
   genuinely absent before recording — do not flag on a bare keyword match.
2. **Hardcoded credentials.** Grep for hardcoded-credential patterns gitleaks may miss:
   credentials assembled from concatenated fragments, non-standard secret variable names,
   default/example passwords left in non-test code, and connection strings with inline
   passwords. Exclude test fixtures, examples, and vendored/generated paths.

Record each Tier 2 finding with `rule` values like `authz-missing-check`,
`secret-weak-compare`, or `hardcoded-credential`.

---

## Step 5: Tier 3 — Posture Checks

Presence/configuration checks, each recorded as a finding when **absent/misconfigured**:

1. **`SECURITY.md` present.** Check for `SECURITY.md` at the repo root (or `.github/SECURITY.md`).
   If absent, record a finding (`rule: posture-security-md-missing`).
2. **SBOM present.** Confirm Tier 1's syft step produced `sbom.cyclonedx.json`. If syft was
   skipped (fallback) or produced no SBOM, record a finding (`rule: posture-sbom-missing`),
   noting whether the cause was a syft download failure.
3. **Branch protection present.** Query the GitHub API for the default branch's protection
   status:
   ```bash
   gh api "repos/{org}/{repo}/branches/{default-branch}/protection" 2>/dev/null
   ```
   Mirror how the codebase reasons about protection elsewhere — presence of
   `required_status_checks` / `required_pull_request_reviews` means protected. If the API call
   returns 404 / "Branch not protected", record a finding
   (`rule: posture-branch-protection-missing`). If the call fails for lack of token/permission
   (not a genuine "unprotected" signal), record it as an **inconclusive** posture note, not a
   confirmed finding — do not assert "unprotected" when you merely couldn't check.

---

## Step 6: Finding-Record Shape

All findings from Tier 1, Tier 2, and Tier 3 use one common record shape:

```json
{
  "id": "security-{rule}-{repo-slug}-{YYYY-Www}",
  "rule": "<e.g. gitleaks-secret | osv-cve | grype-cve | zizmor-lint | authz-missing-check | hardcoded-credential | posture-security-md-missing>",
  "tier": "1 | 2 | 3",
  "severity": "critical | high | medium | low",
  "file": "<path>",
  "line": "<line number if applicable>",
  "description": "<one-line specifics, e.g. CVE id or secret rule>",
  "count": "<occurrence count for this rule this run>"
}
```

The `id` is **repo-namespaced** (`security-{rule}-{repo-slug}-{YYYY-Www}`) exactly as
described in Step 2 — this is the ledger key and the collision-safe finding identifier.

---

## Step 7: Diff Against the Ledger

The ledger lives at `state/security-patrol-ledger.json` — **one level up from the repo
checkout, in agent workspace state, not tracked inside this repo** (same state tier and
location convention as `state/error-patrol-ledger.json` and `state/entropy-patrol-last-run.json`;
it is a sibling of the `repos/<repo>` checkouts, not a path inside the invoking repo's working
tree). This mirrors `error-scan`'s Step 5 classification logic.

1. If `state/security-patrol-ledger.json` does not exist yet, treat the ledger as empty
   (`{"lastRun": null, "findings": {}}`) — a normal first run, not an error.
2. If it exists, read and parse it. Expected shape:
   ```json
   {
     "lastRun": "<ISO8601 timestamp of previous run>",
     "findings": {
       "security-{rule}-{repo-slug}-{YYYY-Www}": {
         "rule": "<rule>",
         "status": "unresolved | resolved",
         "count": <last-seen occurrence count>,
         "lastSeen": "<ISO8601>"
       }
     }
   }
   ```
   Every key is repo-namespaced (`security-{rule}-{repo-slug}-{YYYY-Www}`), so a same-week run
   against a different repo writes distinct keys and never clobbers this repo's entries.
3. Classify each finding from this run against its ledger entry (keyed by its repo-namespaced
   `id`), using the same logic shape as `error-scan`'s Step 5:
   - **New**: no entry exists for this finding's `id` in the ledger at all (first seen this run).
   - **Regressed**: an entry exists, and *either* (a) the ledger's recorded `status` was
     `resolved` (i.e. it was previously marked fixed/absent and has reappeared), *or* (b) the
     status was already `unresolved` but the current `count` is greater than the ledger's
     recorded `count` (it kept firing — more occurrences accumulated since last run). Document
     precisely which condition triggered the regressed flag.
   - **Unchanged**: an entry exists, status was already `unresolved`, and the current `count`
     is not greater than the ledger's recorded `count`. Unchanged findings are **not** listed
     in the report body — only reflected in summary counts.
4. Findings present in the ledger as `unresolved` but absent from this run are presumed
   fixed/resolved since last run — note them for the ledger update in Step 9 (mark
   `status: resolved`), but they need no report section of their own.

---

## Step 8: Write the Report

If `--summary` or `--dry-run` was passed, skip writing the file — for `--dry-run`, print the
exact content that would have been written; for `--summary`, print only the counts table.

Write `security-report.md` to the project root (overwrite if it exists). Format:

```markdown
# Security Report

**Generated:** {YYYY-MM-DD HH:MM} {timezone}
**Repo:** {org/repo}  (repo-slug: {repo-slug})
**ISO week:** {YYYY-Www}

## Summary

| | Count |
|---|---|
| New findings | N |
| Regressed findings | N |
| Unchanged (not shown below) | N |
| Skipped tools | N |

## Skipped Tools

{For each Tier 1 tool whose download/checksum failed:}
- {tool}: download failed, skipped — {error summary}
{If none: "All Tier 1 tools ran."}

---

## New Findings

{If none: "No new findings since last run."}

{For each new finding, as a checkbox:}
- [ ] `{id}` — {description} _{severity}_ (tier {tier})
  - {file}:{line}

## Regressed Findings

{If none: "No regressed findings since last run."}

{For each regressed finding, as a checkbox:}
- [ ] `{id}` — {description} _{severity}_ (tier {tier})
  - Why flagged: {"was resolved, now unresolved" | "count grew from {old} to {new}"}

---
_Run `/security-fix` to classify these findings and queue task-store tasks._
```

New and regressed findings are each sorted by severity (critical → low) within their section.

---

## Step 9: Update the Ledger

Skip this entire step if `--dry-run` was passed (dry runs mutate nothing). `--summary` alone
does **not** skip it — the ledger must stay current so the next run's diff is correct.

1. Build the new ledger content — one entry per finding observed this run, keyed by its
   repo-namespaced `id`:
   ```json
   {
     "lastRun": "<current UTC ISO-8601>",
     "findings": {
       "security-{rule}-{repo-slug}-{YYYY-Www}": {
         "rule": "<rule>",
         "status": "unresolved",
         "count": <current occurrence count>,
         "lastSeen": "<ISO8601>"
       }
     }
   }
   ```
2. For any finding present in the *previous* ledger but absent from this run, retain it with
   `"status": "resolved"` (retaining preserves the "this used to be unresolved" signal for the
   next run's regressed detection).
3. Overwrite `state/security-patrol-ledger.json` with this new content (full replace — a
   current-state snapshot, not an append-only log).
4. Print: `Ledger updated: state/security-patrol-ledger.json`

Because every key includes `{repo-slug}`, overwriting this repo's snapshot never touches
another repo's entries even if both were scanned in the same ISO week.

---

## Step 10: Print Summary

Whether or not `--summary` was passed, always print a summary to stdout after the scan:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECURITY SCAN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Repo:            {org/repo}  ({repo-slug})
  ISO week:        {YYYY-Www}
  Tools run:       {N} / 5   (skipped: {list})

  NEW        {N} findings
  REGRESSED  {N} findings
  ─────────────────────
  Unchanged (not reported): {N}

{If any new/regressed findings exist:}
  Run /security-fix to classify these findings and queue task-store tasks.

{If zero new/regressed findings:}
  ✓ No new or regressed findings since last run.

{If --dry-run: "Dry run — no files written."}
{Else if --summary: "Summary only — security-report.md not written; ledger still updated."}
{Else: "Report written to: security-report.md"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Constraints (Do Not Violate)

- **No code changes.** This skill reads, runs read-only scanners, and reports only. The only
  files written are `security-report.md` (project root) and
  `state/security-patrol-ledger.json` (agent workspace state, one level up from repo
  checkouts) — plus transient tool report artifacts (`gitleaks-report.json`, `osv-report.json`,
  `grype-report.json`, `sbom.cyclonedx.json`, `zizmor-report.json`) which are scan byproducts,
  never committed. Neither the report nor the ledger is written in `--dry-run` mode.
- **No git operations.** Do not commit, branch, or stage anything. Writing scan-local
  entries to `.git/info/exclude` (Step 3.0) is exempt — it is untracked, per-checkout git
  metadata, not the tracked `.gitignore`, and involves no commit, branch, or staged change.
- **No PR creation.** `security-scan` never creates PRs or tasks — queueing findings as
  task-store tasks belongs to `/security-fix`.
- **No tool aborts the scan.** Every Tier 1 tool has a per-tool fallback: a failed download or
  checksum skips only that tool's findings, notes the gap in the report, and the scan
  continues. The overall scan **never fails** because one tool couldn't be fetched or verified.
- **Never ship a fabricated checksum.** Every Tier 1 checksum must match the vendor's published
  SHA256 for the exact pinned version. An unverified-but-plausible hash defeats checksum
  verification — treat an unverifiable tool as unavailable (fallback) instead.
- **Trivy stays excluded.** Do not reintroduce Trivy (GHSA-69fq-xp46-6x23) without an explicit
  security review; Grype + Syft cover container CVE + SBOM.
- **Repo-namespaced IDs, always.** Every ledger key and finding ID is
  `security-{rule}-{repo-slug}-{YYYY-Www}` — never `{rule}-{YYYY-Www}` — so same-week
  multi-repo runs never collide (the `entropy-fix` task-ID collision bug).
- **One scan, one report.** Each run fully overwrites `security-report.md`. The ledger, not old
  reports, is the historical record.
- **Ledger is a snapshot, not a log.** `state/security-patrol-ledger.json` is fully overwritten
  each run with current state.
- **`--dry-run` mutates nothing.** No report write, no ledger write — everything that would be
  written is printed to stdout instead.
- **`--summary` skips only the report file**, not the ledger update.

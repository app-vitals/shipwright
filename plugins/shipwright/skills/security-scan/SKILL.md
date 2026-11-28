---
name: security-scan
description: Scan a repo (required --repo) for secrets, dependency CVEs, container CVEs/SBOM, GitHub Actions issues, authn/authz anti-patterns, and posture gaps across three tiers. Records PatrolFindings in the task store; no repo files, no code changes.
---

# Security Scan

Run a report-only, three-tier security scan against a single repo (named by the required
`--repo`) and record the findings as `PatrolFinding`s in the task store, with one run and its
metrics. All finding detail lives in the store; nothing is written to any repo path. This skill
makes **no code changes** — it reads, runs read-only tools, and records only. A companion `/security-fix` skill (not this one) acts
on the findings.

The three tiers are:

- **Tier 1 — real binaries.** Pinned-version, sha256-verified downloads of `gitleaks` (secret
  scan, full history), `osv-scanner` (lockfile CVEs), `grype` + `syft` (container CVE scan +
  SBOM generation), and `zizmor` (GitHub Actions workflow lint). Each tool has an explicit
  per-tool fallback — if its download or checksum step fails, that one tool's findings are
  skipped, the gap is noted in the summary, and the scan continues. **A single tool's download
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

- `--repo org/repo` — **required** (see Step 2; a usage error is printed without it)
- `--cron ID` — the system-cron id for the recorded run (default `security-patrol-maintenance`)
- `--init` — copy the default security-scan principles file to the project and exit (no scan)
- `--summary` — print counts only
- `--dry-run` — run the full scan and diff but record nothing; print what would be recorded

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

See `references/principles-pattern.md` (relative to the plugin root) for the canonical
description of this override pattern — schema, override semantics, and init flow —
shared with `entropy-scan`.

---

## Step 2: Resolve the Repo, Derive `repo-slug`

This skill scans exactly one repo per invocation, named by the required `--repo org/repo`
argument (e.g. `app-vitals/shipwright`). If `--repo` is missing or not `org/repo`, print and stop:

```
Usage: /security-scan --repo org/repo [--cron ID] [--summary] [--dry-run] [--init]
Error: --repo is required.
```

Set `REPO` to the `--repo` value and `CRON_ID` to the `--cron` value (the system-cron id the
scheduler passes; default `security-patrol-maintenance`). `cd` into the repo's local clone
before Step 3.

Derive `repo-slug`: **the last path segment, lowercased** — e.g. `app-vitals/shipwright` →
`shipwright`. Compute the ISO week as `YYYY-Www` (e.g. `2026-W29`) from the current UTC date.

**Why this matters (critical):** finding fingerprints are namespaced as
`security-{rule}-{repo-slug}-{YYYY-Www}` — rule + **repo-slug** + ISO week — **not** just
`{rule}-{YYYY-Www}`. This avoids the known `entropy-fix` task-ID **collision** bug: when an
ID is built from rule + week only, the same rule firing in two repos in the same ISO week
produces an identical ID, and the second repo's run silently no-ops.

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
2. Count it in `tools_skipped` and note it in the summary, e.g.
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
"$TOOLS_DIR/gitleaks" detect --source . --redact --report-format json --report-path "$TOOLS_DIR/gitleaks-report.json"
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
"$TOOLS_DIR/osv-scanner" scan --recursive --format json --output "$TOOLS_DIR/osv-report.json" .
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
"$TOOLS_DIR/grype" dir:. --exclude './node_modules/**' --exclude './worktrees/**' -o json --file "$TOOLS_DIR/grype-report.json"
```

### 3.4 syft — SBOM generation

Syft is the second Anchore project; same asset/checksum naming as grype
(`syft_{version}_linux_amd64.tar.gz` + `syft_{version}_checksums.txt`). Syft's SBOM output
feeds Tier 3's SBOM-presence posture check.

```bash
curl -sSfL "https://github.com/anchore/syft/releases/download/v1.27.1/syft_1.27.1_linux_amd64.tar.gz" -o "$TOOLS_DIR/syft.tar.gz"
echo "c2cb5867a238baf41adf15f7e01e28cbd886378859eed81e52c080ca0346eefe  $TOOLS_DIR/syft.tar.gz" | sha256sum -c
tar -xz -f "$TOOLS_DIR/syft.tar.gz" -C "$TOOLS_DIR" syft
"$TOOLS_DIR/syft" dir:. --exclude './node_modules/**' --exclude './worktrees/**' -o cyclonedx-json="$TOOLS_DIR/sbom.cyclonedx.json"
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
"$TOOLS_DIR/zizmor" --format json .github/workflows/ > "$TOOLS_DIR/zizmor-report.json"
```

If the repo has no `.github/workflows/` directory, record "no workflows to scan" — not a
failure.

### 3.5a Suppress zizmor Findings Already Covered by `.github/zizmor.yml`

zizmor supports its own `ignore` config in `.github/zizmor.yml`, keyed by exact `file:line`.
That native matching is fragile for this purpose: it pins an **exact line number**, and any
commit that shifts lines above an ignored step — even an unrelated change elsewhere in the
workflow file — moves the finding to a new line and breaks the exact match. When that
happens, a finding a human already reviewed and explicitly accepted as risk silently
resurfaces in `zizmor-report.json` as if it were new, purely from line drift, not from any
change to the risk decision itself. This step applies a drift-tolerant suppression filter on
top of zizmor's raw output before any zizmor finding reaches Step 6 — so a reader skimming
Step 6 should know zizmor findings have already been filtered by the time they get there.

1. **No `.github/zizmor.yml`.** If the file does not exist in the repo, skip this filter
   entirely — proceed with every zizmor finding unfiltered.
2. **Parse ignore entries.** If it exists, parse every rule's `ignore` list into
   `{rule, file, line, stepName}` tuples. Each entry is `{file}:{line}` followed by a
   trailing `# "Step Name" — reason` comment — the step name is the quoted text immediately
   after the `#`. For example, this repo's own `.github/zizmor.yml` has entries like:
   ```
   artipacked:
     ignore:
       - auto-bump-chart.yml:178 # "Checkout main" — pushed from by `git push -u origin "$BRANCH"`
   ```
   which parses to `{rule: "artipacked", file: "auto-bump-chart.yml", line: 178, stepName: "Checkout main"}`.
3. **Match each zizmor finding against the parsed tuples**, rule+file first:
   - No rule+file match in the ignore list → keep the finding; it is not suppressed.
   - Rule+file match found → treat it as the same accepted-risk step (and suppress it) when
     **either**:
     (a) the finding's line is within a small tolerance of the ignore entry's line (±5
     lines), **or**
     (b) re-reading the named workflow file confirms a step named `stepName` still exists
     at/near the finding's actual line (handles drift larger than the tolerance).
   - If neither holds — the named step is gone or renamed — do **not** suppress. Let the
     finding proceed normally; it may be a genuinely new or different finding at that
     location, not the same accepted-risk decision.
4. **Suppressed findings are dropped here, before Step 6.** A suppressed finding gets no
   finding record at all — it is never recorded (Step 8) or diffed against the store
   (Step 7). Step 7's "open in the store but absent from this run ⇒ resolved" logic already handles the case where a finding that used
   to be unresolved becomes suppressed on a later run — no additional store-side logic is
   needed for that transition.

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

## Step 5.5: Apply Suppressions

Runs once, after Tier 1-3 have produced their raw findings and before any of them becomes a
Step 6 record. Suppressions are human-reviewed entries in `.shipwright/suppressions.yml` in
the **scanned repo** (schema: `references/suppressions-schema.md`). This is in addition to,
not a replacement for, the tool-native handling that already ran: `.gitleaksignore`
(gitleaks) and `.github/zizmor.yml` (Step 3.5a) are unchanged.

1. **Build the candidate list.** For each finding from osv-scanner, grype and the Tier 3
   posture checks, emit one object with the suppression `rule` and its match-key fields
   (never a line number):

   | Scanner rule | Suppression `rule` | Match-key fields |
   |---|---|---|
   | `osv-cve` | `osv` | `cve`, `package` |
   | `grype-cve` | `grype` | `cve`, `package` |
   | `posture-*` | `posture` | `path` |

   Findings from rules with no suppression schema (gitleaks, zizmor, authn/authz,
   hardcoded-credential) are not candidates and pass through unchanged.
2. **Filter.** Write the candidates to a temp JSON array and run the shared script from the
   repo being scanned:
   ```bash
   bun "$CLAUDE_PLUGIN_ROOT/scripts/suppressions.ts" --filter .shipwright/suppressions.yml candidates.json
   ```
   It prints `{kept, suppressed, expired}`. A missing suppressions file is valid (nothing
   suppressed). A non-zero exit means the file is invalid — print the error, treat it as
   "no suppressions applied", and note it as a skipped-tool-style gap; never
   abort the scan.
3. **Drop suppressed findings here.** Every finding in `suppressed` is removed before Step 6:
   it gets no finding record, is never recorded (Step 8). Step 7's "open in the store but absent this run ⇒
   resolved" logic covers a finding that becomes suppressed on a later run.
4. **Track the counts** for Step 9: `suppressed_count` = `suppressed.length`, and the
   `expired` entries (rule, match key, `expires`). Expired entries stop suppressing, so their
   findings stay in `kept` and surface normally.

---

## Step 6: Finding-Record Shape

zizmor findings reach this step only after passing the Step 3.5a suppression filter —
anything matching an accepted-risk entry in `.github/zizmor.yml` was already dropped and
never gets a record here.

Group the findings by rule: one record per rule per repo per ISO week. Each record is one
`PatrolFinding` in the task store — all finding detail lives there, never in a repo file:

```json
{
  "fingerprint": "security-{rule}-{repo-slug}-{YYYY-Www}",
  "status": "open",
  "detail": {
    "rule": "<gitleaks-secret | osv-cve | grype-cve | zizmor-lint | authz-missing-check | secret-weak-compare | hardcoded-credential | posture-security-md-missing | ...>",
    "tier": "1 | 2 | 3",
    "severity": "critical | high | medium | low",
    "count": 0,
    "findings": [{ "file": "<path>", "line": 0, "description": "<CVE id, secret rule, ...>" }]
  }
}
```

The `fingerprint` is **repo-namespaced** (`security-{rule}-{repo-slug}-{YYYY-Www}`) exactly as
described in Step 2 — it is the collision-safe finding identifier and `/security-fix` reuses
it as the task id.

---

## Step 7: Diff Against the Store

Load prior state from the task store (read-only; works in `--dry-run` too):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" prior --cron "$CRON_ID" --repo "$REPO" \
  --legacy-shape security-patrol-ledger
```

It prints `{latest, findings, imported}`; `findings` are this repo's PatrolFindings for the
cron. Classify each Step 6 record by its `fingerprint`:

- **New**: no PatrolFinding with that fingerprint.
- **Regressed**: one exists and *either* its `status` was `resolved`, *or* it was `open` and
  the current `detail.count` is greater than the stored `detail.count`.
- **Unchanged**: `open` and the count has not grown. Reflected only in summary counts.
- **Resolved**: stored `open` but absent from this run (a finding that became suppressed
  lands here too). Re-send it with `status: "resolved"` so the next run can detect a regression.

### One-time legacy import (the only place the legacy state files are touched)

The `--legacy-shape security-patrol-ledger` flag above is the one-time import (PCR-2.1). When
the store has no run for this cron+repo yet, the recorder reads the agent-local
`state/security-patrol-ledger.json`, keeps only entries for this repo (other repos' entries are
ignored), posts them as PatrolFindings, and deletes the file after both posts succeed — a
failed post leaves it for a retry. The old `state/security-patrol-last-run.json` marker is
superseded by the recorded run. This skill never reads or writes either file directly and
never creates them.

---

## Step 8: Record the Run

Skip this step if `--dry-run` was passed (dry runs record nothing). `--summary` alone does
**not** skip it.

1. Write the result file **outside the repo**, in a temp dir:
   ```bash
   RESULT="$(mktemp -d)/security-result.json"
   ```
   Content: `{"outcome": "ok", "metrics": {"new": N, "regressed": N, "unchanged": N,
   "resolved": N, "suppressed": N, "tools_skipped": N}, "findings": [<Step 6 records for
   new/regressed/unchanged, plus resolved ones>]}`. Use `"outcome": "no_op"` when nothing
   new, regressed or resolved.
2. Record one run:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron "$CRON_ID" --repo "$REPO" \
     --commit "$(git rev-parse HEAD)" --result "$RESULT" --legacy-shape security-patrol-ledger
   ```
3. Delete the temp result file.

Findings are upserted by fingerprint, so a re-run in the same week is idempotent.

---

## Step 9: Print Summary

Print a summary only — no file is written. Cron runs post this to a channel where nobody can
reply in the moment, so **cap the final response at 3-5 lines**: a status line, the counts,
and a hint. The full detail stays in the store's PatrolFindings — never repeat it here.

```
SECURITY SCAN COMPLETE — {org/repo} ({YYYY-Www}): {N} new, {M} regressed (suppressed: {N})
Tools run: {N} / 5 (skipped: {list})
{If new/regressed: "Next: /security-fix --repo {org/repo} to route findings."}  {If zero: "✓ No new or regressed findings."}
{If expired suppressions: "Expired suppressions: {N}."}
{If --dry-run: "Dry run — nothing recorded."}  {Else: "Recorded to the task store."}
```

---

## Constraints (Do Not Violate)

- **`--repo` is required.** No fallback to the current directory or a repo list.
- **No code changes.** This skill reads, runs read-only scanners, and records to the task
  store only. It writes **no finding to any repo path** — no report file, nothing under the
  project tree. The only local files are transient tool artifacts staged under `$TOOLS_DIR` /
  a temp dir (`gitleaks-report.json`, `osv-report.json`, `grype-report.json`,
  `sbom.cyclonedx.json`, `zizmor-report.json`, the Step 8 result file), never committed.
- **Findings live in the store.** All finding detail is held in `PatrolFinding`; the
  hand-off to `/security-fix` is the store, not a file.
- **No git operations.** Do not commit, branch, or stage anything. Writing scan-local
  entries to `.git/info/exclude` (Step 3.0) is exempt — it is untracked, per-checkout git
  metadata, not the tracked `.gitignore`, and involves no commit, branch, or staged change.
- **No PR creation.** `security-scan` never creates PRs or tasks — routing findings into
  task-store tasks belongs to `/security-fix`.
- **No tool aborts the scan.** Every Tier 1 tool has a per-tool fallback: a failed download or
  checksum skips only that tool's findings, notes the gap in the summary, and the scan
  continues.
- **Never ship a fabricated checksum.** Every Tier 1 checksum must match the vendor's published
  SHA256 for the exact pinned version. An unverified-but-plausible hash defeats checksum
  verification — treat an unverifiable tool as unavailable (fallback) instead.
- **Trivy stays excluded.** Do not reintroduce Trivy (GHSA-69fq-xp46-6x23) without an explicit
  security review; Grype + Syft cover container CVE + SBOM.
- **Never record a finding already suppressed** in `.github/zizmor.yml` (Step 3.5a) or
  `.shipwright/suppressions.yml` (Step 5.5) — it is dropped before Step 6. Expired entries are
  not suppressions: report them in the summary and let their findings through.
- **Repo-namespaced fingerprints, always.** `security-{rule}-{repo-slug}-{YYYY-Www}` — never
  `{rule}-{YYYY-Www}` — so same-week multi-repo runs never collide (the `entropy-fix` task-ID
  collision bug).
- **`--dry-run` records nothing.** Everything that would be recorded is printed instead.

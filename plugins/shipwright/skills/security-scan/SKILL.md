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

> **Checksum note — verify before production use.** Only the `gitleaks` sha256 below is a
> real, verified value (copied from `ci.yml`). The other four checksums are marked
> `<VERIFY-BEFORE-USE>` and **must be replaced with the vendor's published SHA256 for the
> exact pinned version** (from each project's release `checksums.txt` / `SHA256SUMS` /
> `*.sha256` file) before this skill is trusted in production. Do **not** substitute a
> fabricated hash — an unverified-but-plausible hash defeats the entire purpose of checksum
> verification. If you cannot verify a tool's checksum, treat that tool as unavailable and use
> its per-tool fallback rather than shipping a fake hash.

### 3.1 gitleaks — secret scan (full history)

Unlike `ci.yml` (which runs `--no-git` on the working tree), this skill runs a **full-history**
secret scan so secrets committed and later removed are still caught.

```bash
curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v8.27.2/gitleaks_8.27.2_linux_x64.tar.gz" -o gitleaks.tar.gz
echo "141c3b2dede46d8b3a53b47116da756bd223decc0374797559a6b50ecba5590c  gitleaks.tar.gz" | sha256sum -c
tar -xz -f gitleaks.tar.gz gitleaks
./gitleaks detect --source . --redact --report-format json --report-path gitleaks-report.json
```

(Full-history mode: run `gitleaks detect` **without** `--no-git` so it walks the git log.)
Record each finding in the common finding-record shape (Step 6).

### 3.2 osv-scanner — lockfile / dependency CVEs

osv-scanner ships a bare linux amd64 binary named `osv-scanner_{version}_linux_amd64` plus a
`SHA256SUMS` manifest per release.

```bash
curl -sSfL "https://github.com/google/osv-scanner/releases/download/v2.0.2/osv-scanner_2.0.2_linux_amd64" -o osv-scanner
echo "<VERIFY-BEFORE-USE>  osv-scanner" | sha256sum -c
chmod +x osv-scanner
./osv-scanner scan --recursive --format json --output osv-report.json .
```

### 3.3 grype — container / filesystem CVE scan

Anchore projects publish `grype_{version}_linux_amd64.tar.gz` plus a
`grype_{version}_checksums.txt` manifest per release.

```bash
curl -sSfL "https://github.com/anchore/grype/releases/download/v0.116.0/grype_0.116.0_linux_amd64.tar.gz" -o grype.tar.gz
echo "<VERIFY-BEFORE-USE>  grype.tar.gz" | sha256sum -c
tar -xz -f grype.tar.gz grype
./grype dir:. -o json --file grype-report.json
```

### 3.4 syft — SBOM generation

Syft is the second Anchore project; same asset/checksum naming as grype
(`syft_{version}_linux_amd64.tar.gz` + `syft_{version}_checksums.txt`). Syft's SBOM output
feeds Tier 3's SBOM-presence posture check.

```bash
curl -sSfL "https://github.com/anchore/syft/releases/download/v1.27.1/syft_1.27.1_linux_amd64.tar.gz" -o syft.tar.gz
echo "<VERIFY-BEFORE-USE>  syft.tar.gz" | sha256sum -c
tar -xz -f syft.tar.gz syft
./syft dir:. -o cyclonedx-json=sbom.cyclonedx.json
```

The generated `sbom.cyclonedx.json` is the SBOM artifact Tier 3 checks for.

### 3.5 zizmor — GitHub Actions workflow lint

zizmor is a Rust/cargo-dist project; its linux release asset is
`zizmor-{version}-x86_64-unknown-linux-gnu.tar.gz` with per-asset `*.sha256` files.

```bash
curl -sSfL "https://github.com/woodruffw/zizmor/releases/download/v1.5.2/zizmor-1.5.2-x86_64-unknown-linux-gnu.tar.gz" -o zizmor.tar.gz
echo "<VERIFY-BEFORE-USE>  zizmor.tar.gz" | sha256sum -c
tar -xz -f zizmor.tar.gz --strip-components=1 zizmor-1.5.2-x86_64-unknown-linux-gnu/zizmor
./zizmor --format json .github/workflows/ > zizmor-report.json
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
- **No git operations.** Do not commit, branch, or stage anything.
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

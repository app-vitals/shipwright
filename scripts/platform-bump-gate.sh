#!/usr/bin/env bash
#
# scripts/platform-bump-gate.sh <pr-url>
#
# The merge gate of platform-release.yml: wait for the CI workflow run on the
# PR head commit, evaluate the required checks (rerunning failed ones), and
# admin-squash-merge only when they are green. Exits 0 once merged, 1 on any
# no-merge outcome (CI never appeared, no required checks, checks still red
# after the attempts, merge failure). Needs GH_TOKEN in the environment.
#
# The CI wait exists because the fast Conventional-Commit title check registers
# seconds after the push, long before the CI workflow does; evaluating
# "required checks" at that point saw one green check and merged a red bump
# (#4580, #4593).
#
# Tests drive this with a fake `gh` on PATH and zero intervals:
# scripts/platform-bump-gate.unit.test.ts. Tunables (env, defaults in the
# workflow's favour): CI_WAIT_ATTEMPTS=60, CI_WAIT_INTERVAL=5,
# CHECK_REG_ATTEMPTS=30, CHECK_REG_INTERVAL=2, WATCH_INTERVAL=15,
# CHECKS_MAX_ATTEMPTS=3, MERGE_MAX_ATTEMPTS=3, STALE_BASE_DELAY=5.
#
# The check-rerun helpers mirror .github/workflows/test-auto-bump-chart.sh and
# the "Wait for checks and merge" step in auto-bump-chart.yml — keep the
# copies in sync.
#
set -euo pipefail

PR_URL="${1:?usage: platform-bump-gate.sh <pr-url>}"

CI_WAIT_ATTEMPTS="${CI_WAIT_ATTEMPTS:-60}"
CI_WAIT_INTERVAL="${CI_WAIT_INTERVAL:-5}"
CHECK_REG_ATTEMPTS="${CHECK_REG_ATTEMPTS:-30}"
CHECK_REG_INTERVAL="${CHECK_REG_INTERVAL:-2}"
WATCH_INTERVAL="${WATCH_INTERVAL:-15}"
CHECKS_MAX_ATTEMPTS="${CHECKS_MAX_ATTEMPTS:-3}"
MERGE_MAX_ATTEMPTS="${MERGE_MAX_ATTEMPTS:-3}"
STALE_BASE_DELAY="${STALE_BASE_DELAY:-5}"

# Extracts the numeric run id from a `gh pr checks --json link` URL, e.g.
# ".../actions/runs/31518876841/job/93871505296" → "31518876841".
extract_run_id_from_link() {
  local link="$1"
  echo "$link" | sed -n 's#.*/actions/runs/\([0-9]\+\).*#\1#p'
}

# Prints the unique run ids (one per line) behind every required check whose
# state is not SUCCESS, from `gh pr checks --required --json name,state,link`.
failed_required_check_run_ids() {
  local checks_json="$1"
  echo "$checks_json" \
    | python3 -c 'import json, sys; data = json.load(sys.stdin); [print(c["link"]) for c in data if c.get("state") != "SUCCESS"]' \
    | while IFS= read -r link; do
        extract_run_id_from_link "$link"
      done \
    | sort -u
}

# Detects the transient stale-base GraphQL error raised when main moves
# between the checks passing and the merge.
is_stale_base_error() {
  local output="$1"
  if echo "$output" | grep -qi "Base branch was modified"; then
    return 0
  fi
  return 1
}

HEAD_SHA=$(gh pr view "$PR_URL" --json headRefOid -q '.headRefOid')
echo "Waiting for the CI workflow run on ${HEAD_SHA}..."
CI_RUN_ID=""
for _ in $(seq 1 "$CI_WAIT_ATTEMPTS"); do
  CI_RUN_ID=$(gh run list --commit "$HEAD_SHA" --workflow CI --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$CI_RUN_ID" ] && break
  sleep "$CI_WAIT_INTERVAL"
done
if [ -z "$CI_RUN_ID" ]; then
  echo "ERROR: no CI workflow run appeared for ${HEAD_SHA} on ${PR_URL}; not merging." >&2
  exit 1
fi
# The exit status is ignored: failures are evaluated (and failed jobs rerun)
# by the required-checks loop below.
gh run watch "$CI_RUN_ID" --interval "$WATCH_INTERVAL" >/dev/null || true

# `gh pr checks --watch --required` fails fast with "no required checks
# reported" if none is registered. Once CI has completed they all are; still
# guard so a missing set never merges.
echo "Waiting for required checks to register on ${PR_URL}..."
CHECK_COUNT=0
for _ in $(seq 1 "$CHECK_REG_ATTEMPTS"); do
  CHECK_COUNT=$(gh pr checks "$PR_URL" --required --json name -q 'length' 2>/dev/null || echo 0)
  [ "$CHECK_COUNT" -gt 0 ] && break
  sleep "$CHECK_REG_INTERVAL"
done
if [ "$CHECK_COUNT" -eq 0 ]; then
  echo "ERROR: no required checks registered on ${PR_URL}; not merging." >&2
  exit 1
fi

echo "Waiting for required checks on ${PR_URL}..."
for checks_attempt in $(seq 1 "$CHECKS_MAX_ATTEMPTS"); do
  gh pr checks "$PR_URL" --watch --interval "$WATCH_INTERVAL" --required && break

  echo "Required check(s) failed on attempt ${checks_attempt}/${CHECKS_MAX_ATTEMPTS}." >&2

  if [ "$checks_attempt" -ge "$CHECKS_MAX_ATTEMPTS" ]; then
    echo "ERROR: exhausted ${CHECKS_MAX_ATTEMPTS} attempts waiting for required checks to pass on ${PR_URL}." >&2
    exit 1
  fi

  CHECKS_JSON=$(gh pr checks "$PR_URL" --required --json name,state,link)
  RUN_IDS=$(failed_required_check_run_ids "$CHECKS_JSON")

  if [ -z "$RUN_IDS" ]; then
    echo "No failed required check run ids found to rerun — not retrying." >&2
    exit 1
  fi

  echo "Rerunning failed job(s) behind: $(echo "$RUN_IDS" | paste -sd, -)"
  while IFS= read -r run_id; do
    [ -z "$run_id" ] && continue
    gh run rerun "$run_id" --failed
  done <<< "$RUN_IDS"
done
echo "Checks passed — merging ${PR_URL}."

for attempt in $(seq 1 "$MERGE_MAX_ATTEMPTS"); do
  MERGE_OUTPUT=$(gh pr merge "$PR_URL" --squash --admin 2>&1) && {
    echo "$MERGE_OUTPUT"
    echo "Merged ${PR_URL}."
    exit 0
  }

  echo "$MERGE_OUTPUT" >&2

  if is_stale_base_error "$MERGE_OUTPUT" && [ "$attempt" -lt "$MERGE_MAX_ATTEMPTS" ]; then
    echo "Stale-base race detected (attempt ${attempt}/${MERGE_MAX_ATTEMPTS}) — retrying in ${STALE_BASE_DELAY}s..."
    sleep "$STALE_BASE_DELAY"
    continue
  fi

  echo "Merge failed on attempt ${attempt}/${MERGE_MAX_ATTEMPTS} — not retrying (either not a stale-base error, or retries exhausted)."
  exit 1
done

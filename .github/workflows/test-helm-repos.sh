#!/usr/bin/env bash
#
# .github/workflows/test-helm-repos.sh
#
# Unit-tests .github/actions/helm-repos/helm-repos.sh (the retrying
# `helm repo add` / `helm repo update` wrapper used by chart-release.yml,
# helm.yml and library-chart-release.yml) with a fake `helm` on PATH.
# No network, no real helm required.
#
# Run: bash .github/workflows/test-helm-repos.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/../actions/helm-repos/helm-repos.sh"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$(( PASS + 1 )); }
fail() { echo "  FAIL: $1 — expected '$2', got '$3'"; FAIL=$(( FAIL + 1 )); }
assert_eq() {
  if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

# Fake helm: logs each call; fails the first $FAKE_FAIL_N calls matching
# $FAKE_FAIL_ON (substring of the args, default: all calls) with a 503 message.
cat > "$TMP/bin/helm" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [[ "$*" == *"${FAKE_FAIL_ON:-}"* ]]; then
  c=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0)
  c=$(( c + 1 )); echo "$c" > "$FAKE_COUNT"
  if [[ $c -le ${FAKE_FAIL_N:-0} ]]; then
    echo "Error: failed to fetch https://example.test/index.yaml : 503 Service Unavailable" >&2
    exit 1
  fi
fi
exit 0
FAKE
chmod +x "$TMP/bin/helm"

REPOS=$'a https://a.test\nb https://b.test'

# run_case <fail_n> <fail_on> : sets RC, OUT, and LOG contents
run_case() {
  export FAKE_LOG="$TMP/log" FAKE_COUNT="$TMP/count"
  rm -f "$FAKE_LOG" "$FAKE_COUNT"; : > "$FAKE_LOG"
  RC=0
  OUT=$(PATH="$TMP/bin:$PATH" FAKE_FAIL_N="$1" FAKE_FAIL_ON="$2" \
        HELM_REPOS="$REPOS" HELM_REPOS_SLEEP_SCALE=0 \
        bash "$TARGET" 2>&1) || RC=$?
  LOG=$(cat "$FAKE_LOG")
}

echo "healthy network"
run_case 0 ""
assert_eq "exit 0" 0 "$RC"
assert_eq "adds in order then updates" \
  $'repo add a https://a.test\nrepo add b https://b.test\nrepo update' "$LOG"

echo "transient failures then success"
run_case 3 "repo add b"
assert_eq "exit 0 after 3 failures (4th attempt succeeds)" 0 "$RC"
assert_eq "b added 4 times" 4 "$(grep -c '^repo add b' <<<"$LOG")"
assert_eq "a added once (no re-add on retry)" 1 "$(grep -c '^repo add a' <<<"$LOG")"
assert_eq "update ran once" 1 "$(grep -c '^repo update' <<<"$LOG")"

echo "transient failure on update"
run_case 2 "repo update"
assert_eq "exit 0" 0 "$RC"
assert_eq "update retried 3 times" 3 "$(grep -c '^repo update' <<<"$LOG")"

echo "persistent failure"
run_case 999 "repo add a"
assert_eq "non-zero exit" 1 "$([[ $RC -ne 0 ]] && echo 1 || echo 0)"
assert_eq "bounded to 4 attempts" 4 "$(grep -c '^repo add a' <<<"$LOG")"
assert_eq "stops before later repos" 0 "$(grep -c '^repo add b' <<<"$LOG")"
assert_eq "helm error is in the log" 1 "$([[ "$OUT" == *"503 Service Unavailable"* ]] && echo 1 || echo 0)"

echo "persistent failure on update"
run_case 999 "repo update"
assert_eq "non-zero exit" 1 "$([[ $RC -ne 0 ]] && echo 1 || echo 0)"
assert_eq "update bounded to 4 attempts" 4 "$(grep -c '^repo update' <<<"$LOG")"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

#!/usr/bin/env bash
#
# scripts/bump-chart.sh — automated Helm chart version bump
#
# Usage:
#   ./scripts/bump-chart.sh [patch|minor|major] [--message '...'] [--dry-run]
#
# Defaults:
#   bump type = patch
#
# What it does:
#   1. Reads the current version from charts/shipwright/Chart.yaml using yq
#   2. Increments the version according to the bump type (patch/minor/major)
#   3. Updates Chart.yaml: version field and artifacthub.io/changes annotation
#   4. Prepends a ## [X.Y.Z] - YYYY-MM-DD section to charts/shipwright/CHANGELOG.md
#   5. Creates branch chore/chart-vX.Y.Z
#   6. Commits all changes and pushes the branch
#   7. Opens a PR via 'gh pr create'
#
# Idempotent: if branch chore/chart-vX.Y.Z already exists (locally or on remote),
# the script exits 0 cleanly without making any changes.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHART_YAML="${REPO_ROOT}/charts/shipwright/Chart.yaml"
CHANGELOG="${REPO_ROOT}/charts/shipwright/CHANGELOG.md"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

BUMP_TYPE="patch"
MESSAGE=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major)
      BUMP_TYPE="$1"
      shift
      ;;
    --message|-m)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --message requires a value" >&2
        exit 1
      fi
      MESSAGE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [patch|minor|major] [--message '...'] [--dry-run]"
      echo ""
      echo "  patch|minor|major   Version bump type (default: patch)"
      echo "  --message '...'     Change description for artifacthub.io/changes and CHANGELOG"
      echo "  --dry-run           Print what would happen without making any changes"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

require() {
  local bin="$1"
  local hint="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "ERROR: required tool '$bin' not found on PATH." >&2
    echo "       ${hint}" >&2
    exit 1
  fi
}

require yq  "Install yq: https://github.com/mikefarah/yq#install (brew install yq)"
require gh  "Install gh: https://cli.github.com (brew install gh)"
require git "Install git: https://git-scm.com/downloads"

if [[ ! -f "${CHART_YAML}" ]]; then
  echo "ERROR: Chart.yaml not found at ${CHART_YAML}" >&2
  exit 1
fi

if [[ ! -f "${CHANGELOG}" ]]; then
  echo "ERROR: CHANGELOG.md not found at ${CHANGELOG}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Version calculation
# ---------------------------------------------------------------------------

CURRENT_VERSION="$(yq '.version' "${CHART_YAML}")"

if [[ -z "${CURRENT_VERSION}" || "${CURRENT_VERSION}" == "null" ]]; then
  echo "ERROR: Could not read version from ${CHART_YAML}" >&2
  exit 1
fi

# Parse semver components
IFS='.' read -r MAJOR MINOR PATCH <<< "${CURRENT_VERSION}"

if [[ -z "${MAJOR}" || -z "${MINOR}" || -z "${PATCH}" ]]; then
  echo "ERROR: Could not parse version '${CURRENT_VERSION}' as X.Y.Z" >&2
  exit 1
fi

case "${BUMP_TYPE}" in
  patch)
    PATCH=$(( PATCH + 1 ))
    ;;
  minor)
    MINOR=$(( MINOR + 1 ))
    PATCH=0
    ;;
  major)
    MAJOR=$(( MAJOR + 1 ))
    MINOR=0
    PATCH=0
    ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
BRANCH="chore/chart-v${NEW_VERSION}"
TODAY="$(date +%Y-%m-%d)"

# Default message if not provided
if [[ -z "${MESSAGE}" ]]; then
  MESSAGE="${BUMP_TYPE}: chart version bump to ${NEW_VERSION}"
fi

echo "[bump-chart] current version : ${CURRENT_VERSION}"
echo "[bump-chart] new version      : ${NEW_VERSION}"
echo "[bump-chart] bump type        : ${BUMP_TYPE}"
echo "[bump-chart] branch           : ${BRANCH}"
echo "[bump-chart] message          : ${MESSAGE}"
echo "[bump-chart] dry-run          : ${DRY_RUN}"

# ---------------------------------------------------------------------------
# Idempotency check — exit cleanly if branch already exists
# ---------------------------------------------------------------------------

# Check local branches
if git -C "${REPO_ROOT}" branch --list "${BRANCH}" | grep -q .; then
  echo "[bump-chart] Branch '${BRANCH}' already exists locally — nothing to do."
  exit 0
fi

# Check remote branches
if git -C "${REPO_ROOT}" ls-remote --heads origin "${BRANCH}" 2>/dev/null | grep -q .; then
  echo "[bump-chart] Branch '${BRANCH}' already exists on remote — nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Dry-run mode — print plan and exit
# ---------------------------------------------------------------------------

if [[ "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "[bump-chart] DRY RUN — no changes will be made."
  echo "[bump-chart] Would update Chart.yaml:"
  echo "             version: ${CURRENT_VERSION} → ${NEW_VERSION}"
  echo "             artifacthub.io/changes: '${MESSAGE}'"
  echo "[bump-chart] Would prepend to CHANGELOG.md:"
  echo "             ## [${NEW_VERSION}] - ${TODAY}"
  echo "[bump-chart] Would create branch '${BRANCH}', commit, push, and open PR."
  exit 0
fi

# ---------------------------------------------------------------------------
# Update Chart.yaml — version field
# ---------------------------------------------------------------------------

echo "[bump-chart] updating Chart.yaml version..."
yq -i ".version = \"${NEW_VERSION}\"" "${CHART_YAML}"

# ---------------------------------------------------------------------------
# Update Chart.yaml — artifacthub.io/changes annotation
# ---------------------------------------------------------------------------

echo "[bump-chart] updating artifacthub.io/changes annotation..."

# Use yq's strenv() to safely pass multiline content without shell escaping issues.
# CHANGES_BLOCK is exported so yq can read it via strenv().
CHANGES_BLOCK="- kind: changed
  description: \"${MESSAGE}\"
"
export CHANGES_BLOCK
yq -i '.annotations["artifacthub.io/changes"] = strenv(CHANGES_BLOCK)' "${CHART_YAML}"

# ---------------------------------------------------------------------------
# Update CHANGELOG.md — prepend new section after the header block
# ---------------------------------------------------------------------------

echo "[bump-chart] updating CHANGELOG.md..."

# Build the new section text
NEW_SECTION="## [${NEW_VERSION}] - ${TODAY}

### Changed

- ${MESSAGE}"

# Find the line number of the first existing ## section, then insert before it
# The CHANGELOG header ends before the first "## [" line.
# We use a Python-based sed-equivalent for reliable multi-line insertion.
TMPFILE="$(mktemp)"
trap 'rm -f "${TMPFILE}"' EXIT

python3 - "${CHANGELOG}" "${NEW_SECTION}" "${TMPFILE}" <<'PYEOF'
import sys

changelog_path = sys.argv[1]
new_section = sys.argv[2]
tmp_path = sys.argv[3]

with open(changelog_path, 'r') as f:
    content = f.read()

lines = content.split('\n')
insert_at = None

for i, line in enumerate(lines):
    if line.startswith('## ['):
        insert_at = i
        break

if insert_at is None:
    # No existing section found — append at end
    new_content = content.rstrip('\n') + '\n\n' + new_section + '\n'
else:
    before = '\n'.join(lines[:insert_at])
    after = '\n'.join(lines[insert_at:])
    # Ensure a blank line separates the header block from the new section
    if before.rstrip('\n'):
        separator = '\n\n'
    else:
        separator = '\n'
    new_content = before.rstrip('\n') + separator + new_section + '\n\n' + after

with open(tmp_path, 'w') as f:
    f.write(new_content)
PYEOF

mv "${TMPFILE}" "${CHANGELOG}"

# ---------------------------------------------------------------------------
# Git: create branch, stage, commit
# ---------------------------------------------------------------------------

echo "[bump-chart] creating branch ${BRANCH}..."
CURRENT_BRANCH=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)
if [[ "${CURRENT_BRANCH}" != "main" ]]; then
  echo "ERROR: must run from main (currently on ${CURRENT_BRANCH})" >&2
  exit 1
fi
git -C "${REPO_ROOT}" checkout -b "${BRANCH}"

echo "[bump-chart] staging changes..."
git -C "${REPO_ROOT}" add "${CHART_YAML}" "${CHANGELOG}"

echo "[bump-chart] committing..."
git -C "${REPO_ROOT}" commit -m "chore(chart): bump chart version to ${NEW_VERSION}

${MESSAGE}"

# ---------------------------------------------------------------------------
# Git: push branch
# ---------------------------------------------------------------------------

echo "[bump-chart] pushing branch..."
git -C "${REPO_ROOT}" push -u origin "${BRANCH}"

# ---------------------------------------------------------------------------
# GitHub: open PR
# ---------------------------------------------------------------------------

echo "[bump-chart] opening PR..."
gh pr create \
  --repo "$(git -C "${REPO_ROOT}" remote get-url origin | sed 's|.*github\.com[:/]||;s|\.git$||')" \
  --base main \
  --head "${BRANCH}" \
  --title "chore(chart): bump chart version to ${NEW_VERSION}" \
  --body "$(cat <<EOF
## Chart version bump: ${CURRENT_VERSION} → ${NEW_VERSION}

**Bump type:** ${BUMP_TYPE}
**New version:** ${NEW_VERSION}
**Date:** ${TODAY}

### Changes

${MESSAGE}

---

This PR was created automatically by \`scripts/bump-chart.sh\`.

After merge, the \`chart-release.yml\` CI workflow will package and publish
the updated chart to the Helm repository.
EOF
)"

echo "[bump-chart] done. PR opened for chart v${NEW_VERSION}."

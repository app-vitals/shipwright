#!/usr/bin/env bash
#
# scripts/check-downstream-compat.sh — downstream-compatibility render-diff
#
# Usage:
#   ./scripts/check-downstream-compat.sh <wrapper-dir> \
#       [--baseline <published-version>] [--values <values-file>] \
#       [--repo-url <helm-repo-url>] [--dep-name <chart-dependency-name>]
#
# What is a "wrapper"?
#   A downstream consumer repo that vendors/depends on the `shipwright` Helm
#   chart (charts/shipwright in THIS repo) as a chart dependency inside its
#   own umbrella chart. See docs/helm-repo.md for how this repo's chart is
#   published to the gh-pages branch as a Helm repository (index.yaml +
#   a .tgz per version). <wrapper-dir> is always a caller-supplied path to
#   that downstream chart — this script never assumes a specific wrapper
#   location or identity.
#
# What this script does:
#   Renders THREE variants of the SAME wrapper chart and diffs them:
#
#     Render A — the wrapper as-is: `helm template <wrapper-dir>` using
#       whatever chart version/source the wrapper currently has pinned in
#       its own Chart.lock / vendored charts/ subchart, unmodified.
#
#     Render B — the same wrapper, but with its `shipwright` dependency
#       swapped to a specific PUBLISHED baseline version pulled fresh from
#       the gh-pages Helm repository. `--baseline <version>` picks the
#       version explicitly. If omitted, the default is the wrapper's own
#       currently-pinned shipwright version (i.e. compare against the exact
#       published version the wrapper already declares) — this is the
#       sensible default because it isolates "does swapping a *pinned*
#       source for the *same-version* published artifact change anything"
#       from "did a version bump change something", which is a separate,
#       expected kind of diff. Pass --baseline explicitly to compare against
#       a different published version (e.g. "latest").
#
#     Render C — the same wrapper, but with its `shipwright` dependency
#       swapped to a chart packaged from THIS repo's current working tree
#       (`helm package charts/shipwright` into a scratch dir, then the
#       wrapper's dependency is pointed at that local .tgz).
#
#   Diff logic:
#     1. Diff A vs B, after normalizing the `helm.sh/chart:` label line
#        (which legitimately differs pinned-vs-baseline) and allowlisting
#        image-tag-only diff lines (a changed line where the only
#        difference is an image tag value is not a failure). Any other
#        remaining diff fails loudly.
#     2. Diff B vs C, with the same helm.sh/chart normalization but NO
#        allowlist — this diff must be completely empty. Any diff here
#        means the working tree changed the wrapper's render relative to
#        the published baseline: a compatibility break.
#     3. Run the wrapper's own `helm lint` and `helm template` against its
#        own values.yaml (or --values) and fail if either errors.
#
# The published-chart repository URL is NEVER hardcoded. It is derived, in
# order of preference:
#   1. --repo-url, if passed explicitly.
#   2. The wrapper's own Chart.yaml `dependencies[]` entry whose name matches
#      --dep-name (default: "shipwright") — its `repository:` field IS the
#      published Helm repo URL, exactly as the wrapper already trusts it.
#   3. GitHub Pages convention applied to THIS repo's own `git remote
#      get-url origin` at runtime (https://<owner>.github.io/<repo>), which
#      is how docs/helm-repo.md says this repo's own chart is published.
#      This is a runtime derivation, not a hardcoded string.
#
# Self-test / smoke-test mode (no external wrapper available):
#   Because a real downstream wrapper repo doesn't exist inside this repo,
#   pass THIS repo's own charts/shipwright as <wrapper-dir>. charts/shipwright
#   has no "shipwright"-named dependency to swap (it IS the shipwright
#   chart), so Render A and Render B degenerate to the same thing (there is
#   nothing published to swap to that isn't already what's on disk), and the
#   meaningful check becomes Render A/B (rendered directly from the working
#   tree) vs Render C (rendered from the working-tree-packaged .tgz of the
#   SAME chart) — the diff/normalization pipeline should report these
#   identical. This is a degenerate case of the SAME general mechanism
#   (Render C is always "package charts/shipwright from the working tree and
#   render through it"), not a separate code path — see CONTRIBUTING.md for
#   the exact copy-pasteable command. When --dep-name does not match any
#   dependency in the wrapper's Chart.yaml, the script automatically falls
#   back to this self-referential mode: Render A is used directly as Render
#   B (skipping the "swap to a published baseline" step, since there is no
#   separate dependency to swap), and only the B vs C (baseline vs
#   working-tree) comparison is meaningful.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHART_DIR="${REPO_ROOT}/charts/shipwright"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

WRAPPER_DIR=""
BASELINE_VERSION=""
VALUES_FILE=""
REPO_URL=""
DEP_NAME="shipwright"

usage() {
  cat <<EOF
Usage: $0 <wrapper-dir> [--baseline <published-version>] [--values <values-file>] [--repo-url <helm-repo-url>] [--dep-name <chart-dependency-name>]

  <wrapper-dir>            Path to a downstream chart that depends on the
                            shipwright chart (or, for the self-test smoke
                            run, this repo's own charts/shipwright).

  --baseline <version>     Published shipwright chart version to render as
                            the baseline (Render B). Default: the version
                            currently pinned in <wrapper-dir>/Chart.yaml's
                            "${DEP_NAME}" dependency entry (compares the
                            pinned source against the exact same published
                            version). Pass a different version (or "latest"
                            equivalents via helm search) to compare against
                            a newer/older published release instead.

  --values <file>          Values file to lint/template the wrapper with,
                            resolved relative to <wrapper-dir> (e.g.
                            "values-prod.yaml" means
                            <wrapper-dir>/values-prod.yaml). Default:
                            <wrapper-dir>/values.yaml if present.

  --repo-url <url>         Published Helm repository URL to pull the
                            baseline chart from. Default: derived from the
                            wrapper's own Chart.yaml dependency entry for
                            "${DEP_NAME}", falling back to the GitHub Pages
                            convention (https://<owner>.github.io/<repo>)
                            applied to this repo's own "git remote get-url
                            origin" at runtime. Never hardcoded.

  --dep-name <name>        Name of the shipwright chart dependency inside
                            the wrapper's Chart.yaml. Default: "shipwright".
                            If no dependency with this name exists (e.g.
                            when <wrapper-dir> IS charts/shipwright itself,
                            for the self-test smoke run), the script falls
                            back to the degenerate self-referential mode
                            described in the script's header comment.

  -h, --help                Show this help text and exit.
EOF
}

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --baseline)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --baseline requires a value" >&2
        exit 1
      fi
      BASELINE_VERSION="$2"
      shift 2
      ;;
    --values)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --values requires a value" >&2
        exit 1
      fi
      VALUES_FILE="$2"
      shift 2
      ;;
    --repo-url)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --repo-url requires a value" >&2
        exit 1
      fi
      REPO_URL="$2"
      shift 2
      ;;
    --dep-name)
      if [[ -z "${2:-}" ]]; then
        echo "ERROR: --dep-name requires a value" >&2
        exit 1
      fi
      DEP_NAME="$2"
      shift 2
      ;;
    -*)
      echo "ERROR: unknown argument '$1'" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 1
      ;;
    *)
      if [[ -n "${WRAPPER_DIR}" ]]; then
        echo "ERROR: unexpected extra positional argument '$1'" >&2
        exit 1
      fi
      WRAPPER_DIR="$1"
      shift
      ;;
  esac
done

if [[ -z "${WRAPPER_DIR}" ]]; then
  echo "ERROR: <wrapper-dir> is required." >&2
  usage >&2
  exit 1
fi

# Resolve wrapper-dir to an absolute path.
if [[ ! -d "${WRAPPER_DIR}" ]]; then
  echo "ERROR: wrapper dir '${WRAPPER_DIR}' does not exist or is not a directory." >&2
  exit 1
fi
WRAPPER_DIR="$(cd "${WRAPPER_DIR}" && pwd)"
WRAPPER_CHART_YAML="${WRAPPER_DIR}/Chart.yaml"

if [[ ! -f "${WRAPPER_CHART_YAML}" ]]; then
  echo "ERROR: no Chart.yaml found at ${WRAPPER_CHART_YAML} — <wrapper-dir> must be a Helm chart directory." >&2
  exit 1
fi

echo "[check-downstream-compat] wrapper dir      : ${WRAPPER_DIR}"

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

require helm    "Install helm: https://helm.sh/docs/intro/install/"
require git     "Install git: https://git-scm.com/downloads"
require diff    "Install diffutils (usually preinstalled; e.g. apt install diffutils)"
require yq      "Install yq: https://github.com/mikefarah/yq#install (brew install yq)"
require python3 "Install Python 3 (usually preinstalled; e.g. apt install python3)"

if [[ ! -d "${CHART_DIR}" ]]; then
  echo "ERROR: charts/shipwright not found at ${CHART_DIR} (this script must run from the shipwright repo)." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Scratch workspace
# ---------------------------------------------------------------------------

SCRATCH_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${SCRATCH_DIR}"
}
trap cleanup EXIT

RENDER_A="${SCRATCH_DIR}/render-a.yaml"
RENDER_B="${SCRATCH_DIR}/render-b.yaml"
RENDER_C="${SCRATCH_DIR}/render-c.yaml"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Copy the wrapper chart into a fresh scratch subdirectory so dependency
# swaps never mutate the caller's working tree.
copy_wrapper() {
  local dest="$1"
  mkdir -p "${dest}"
  cp -R "${WRAPPER_DIR}/." "${dest}/"
  # Drop any pre-existing charts/ (vendored deps) and Chart.lock — both are
  # regenerated by `helm dependency update` after the swap so the swap
  # actually takes effect instead of resolving from a stale lock/vendor dir.
  rm -rf "${dest}/charts" "${dest}/Chart.lock"
}

# Look up the wrapper's Chart.yaml dependency entry matching DEP_NAME.
# Prints the field requested ("version" or "repository"), or empty if the
# dependency is not present.
wrapper_dep_field() {
  local field="$1"
  yq -r ".dependencies[] | select(.name == \"${DEP_NAME}\") | .${field} // \"\"" "${WRAPPER_CHART_YAML}" 2>/dev/null | head -n1
}

# `helm template` a chart dir with the resolved VALUES_ARGS, writing to $2.
render_variant() {
  local chart_dir="$1"
  local out="$2"
  helm template compat-check "${chart_dir}" "${VALUES_ARGS[@]}" > "${out}"
}

# Normalize output that legitimately (and expectedly) differs between two
# otherwise-identical renders, so it never shows up as a spurious diff line:
#
#   - the helm.sh/chart: label line, which encodes a chart version string
#     that legitimately differs between pinned/baseline/working-tree.
#   - Secret data/stringData values, which any chart using the common
#     "generate random material on first install, else reuse the lookup'd
#     Secret" idiom (e.g. randAlphaNum-generated passwords/keys) will emit
#     freshly-randomized on every `helm template` invocation, since
#     `helm template` never executes `lookup`. This is inherent to that
#     idiom and not specific to any one chart — comparing two independent
#     `helm template` runs of the SAME chart+values would otherwise always
#     show a spurious Secret-payload diff.
normalize_render() {
  local src="$1"
  local dst="$2"
  sed -E 's/^([[:space:]]*helm\.sh\/chart:).*/\1 NORMALIZED/' "${src}" > "${dst}.tmp"
  python3 - "${dst}.tmp" "${dst}" <<'PYEOF'
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path) as f:
    docs = f.read().split('\n---\n')

out_docs = []
for doc in docs:
    lines = doc.split('\n')
    is_secret = any(l.strip() in ('kind: Secret',) for l in lines)
    if not is_secret:
        out_docs.append(doc)
        continue
    in_data_block = False
    data_indent = None
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped in ('data:', 'stringData:'):
            in_data_block = True
            data_indent = len(line) - len(line.lstrip(' '))
            new_lines.append(line)
            continue
        if in_data_block:
            indent = len(line) - len(line.lstrip(' '))
            if stripped and indent <= data_indent:
                in_data_block = False
            elif stripped.startswith('#'):
                new_lines.append(line)
                continue
            elif ':' in stripped:
                key = line.split(':', 1)[0]
                new_lines.append(f"{key}: NORMALIZED")
                continue
        new_lines.append(line)
    out_docs.append('\n'.join(new_lines))

with open(dst_path, 'w') as f:
    f.write('\n---\n'.join(out_docs))
PYEOF
  rm -f "${dst}.tmp"
}

# ---------------------------------------------------------------------------
# Resolve the published Helm repository URL (never hardcoded)
# ---------------------------------------------------------------------------

resolve_repo_url() {
  if [[ -n "${REPO_URL}" ]]; then
    echo "${REPO_URL}"
    return
  fi

  local dep_repo
  dep_repo="$(wrapper_dep_field repository)"
  if [[ -n "${dep_repo}" && "${dep_repo}" != "null" ]]; then
    echo "${dep_repo}"
    return
  fi

  # Fall back to the GitHub Pages convention applied to THIS repo's own git
  # remote at runtime: https://<owner>.github.io/<repo>. Derived, not
  # hardcoded — see docs/helm-repo.md for why this repo's chart is published
  # this way.
  local origin_url owner_repo owner repo
  origin_url="$(git -C "${REPO_ROOT}" remote get-url origin 2>/dev/null || true)"
  if [[ -z "${origin_url}" ]]; then
    echo "ERROR: could not derive a Helm repository URL — no --repo-url given, no matching '${DEP_NAME}' dependency in ${WRAPPER_CHART_YAML}, and 'git remote get-url origin' failed." >&2
    exit 1
  fi
  # Strip scheme/host prefix and a trailing .git, leaving "<owner>/<repo>".
  owner_repo="$(echo "${origin_url}" | sed -E 's#^(git@|https://|http://)##; s#^[^:/]+[:/]##; s#\.git$##')"
  owner="$(echo "${owner_repo}" | cut -d/ -f1)"
  repo="$(echo "${owner_repo}" | cut -d/ -f2)"
  if [[ -z "${owner}" || -z "${repo}" ]]; then
    echo "ERROR: could not parse owner/repo out of origin URL '${origin_url}'." >&2
    exit 1
  fi
  echo "https://${owner}.github.io/${repo}"
}

# ---------------------------------------------------------------------------
# Values file resolution
# ---------------------------------------------------------------------------

VALUES_ARGS=()
if [[ -n "${VALUES_FILE}" ]]; then
  RESOLVED_VALUES="${WRAPPER_DIR}/${VALUES_FILE}"
  if [[ ! -f "${RESOLVED_VALUES}" ]]; then
    echo "ERROR: --values file not found at ${RESOLVED_VALUES}" >&2
    exit 1
  fi
  VALUES_ARGS=(--values "${RESOLVED_VALUES}")
elif [[ -f "${WRAPPER_DIR}/values.yaml" ]]; then
  VALUES_ARGS=(--values "${WRAPPER_DIR}/values.yaml")
fi

# ---------------------------------------------------------------------------
# Render A — the wrapper as-is
# ---------------------------------------------------------------------------

echo "[check-downstream-compat] rendering A (wrapper as-is)..."
RENDER_A_DIR="${SCRATCH_DIR}/wrapper-as-is"
copy_wrapper "${RENDER_A_DIR}"
if [[ -f "${WRAPPER_DIR}/Chart.lock" || -d "${WRAPPER_DIR}/charts" ]]; then
  # Restore the wrapper's own vendored charts/ dir (excluded by copy_wrapper)
  # so Render A truly reflects whatever the wrapper currently has pinned.
  if [[ -d "${WRAPPER_DIR}/charts" ]]; then
    cp -R "${WRAPPER_DIR}/charts" "${RENDER_A_DIR}/charts"
  fi
  if [[ -f "${WRAPPER_DIR}/Chart.lock" ]]; then
    cp "${WRAPPER_DIR}/Chart.lock" "${RENDER_A_DIR}/Chart.lock"
  fi
fi
render_variant "${RENDER_A_DIR}" "${RENDER_A}"

# ---------------------------------------------------------------------------
# Determine whether the wrapper has a matching dependency to swap
# ---------------------------------------------------------------------------

DEP_VERSION="$(wrapper_dep_field version)"
HAS_DEP=true
if [[ -z "${DEP_VERSION}" || "${DEP_VERSION}" == "null" ]]; then
  HAS_DEP=false
  echo "[check-downstream-compat] no '${DEP_NAME}' dependency found in ${WRAPPER_CHART_YAML} — falling back to self-referential mode (see script header). Render B = Render A."
fi

# ---------------------------------------------------------------------------
# Render B — wrapper with the dependency swapped to a published baseline
# ---------------------------------------------------------------------------

if [[ "${HAS_DEP}" == "true" ]]; then
  EFFECTIVE_BASELINE="${BASELINE_VERSION:-${DEP_VERSION}}"
  REPO_URL_RESOLVED="$(resolve_repo_url)"
  echo "[check-downstream-compat] repo url          : ${REPO_URL_RESOLVED}"
  echo "[check-downstream-compat] baseline version   : ${EFFECTIVE_BASELINE}"
  echo "[check-downstream-compat] rendering B (dependency swapped to published baseline)..."

  RENDER_B_DIR="${SCRATCH_DIR}/wrapper-baseline"
  copy_wrapper "${RENDER_B_DIR}"
  yq -i "(.dependencies[] | select(.name == \"${DEP_NAME}\")).version = \"${EFFECTIVE_BASELINE}\" | (.dependencies[] | select(.name == \"${DEP_NAME}\")).repository = \"${REPO_URL_RESOLVED}\"" "${RENDER_B_DIR}/Chart.yaml"
  helm dependency update "${RENDER_B_DIR}" >/dev/null
  render_variant "${RENDER_B_DIR}" "${RENDER_B}"
else
  cp "${RENDER_A}" "${RENDER_B}"
fi

# ---------------------------------------------------------------------------
# Render C — wrapper with the dependency swapped to a working-tree package
# ---------------------------------------------------------------------------

echo "[check-downstream-compat] packaging charts/shipwright from the working tree..."
PACKAGE_DIR="${SCRATCH_DIR}/package"
mkdir -p "${PACKAGE_DIR}"
helm package "${CHART_DIR}" --destination "${PACKAGE_DIR}" >/dev/null

WORKING_TREE_TGZ="$(find "${PACKAGE_DIR}" -maxdepth 1 -name '*.tgz' | head -n1)"
if [[ -z "${WORKING_TREE_TGZ}" ]]; then
  echo "ERROR: helm package produced no .tgz in ${PACKAGE_DIR}" >&2
  exit 1
fi

echo "[check-downstream-compat] rendering C (dependency swapped to working-tree package)..."

# Unpack the working-tree .tgz into a plain chart directory. Helm's `file://`
# dependency scheme resolves directly against a local chart directory (NOT
# an indexed repo — `helm repo index` + file:// does not work for
# `helm dependency update`), so this unpacked dir is reused for both the
# has-dependency swap below AND the self-referential mode.
UNPACK_DIR="${SCRATCH_DIR}/unpacked-worktree"
mkdir -p "${UNPACK_DIR}"
tar xzf "${WORKING_TREE_TGZ}" -C "${UNPACK_DIR}"
UNPACKED_CHART_DIR="$(find "${UNPACK_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n1)"

if [[ "${HAS_DEP}" == "true" ]]; then
  RENDER_C_DIR="${SCRATCH_DIR}/wrapper-worktree"
  copy_wrapper "${RENDER_C_DIR}"
  WORKING_TREE_VERSION="$(yq -r '.version' "${CHART_DIR}/Chart.yaml")"
  yq -i "(.dependencies[] | select(.name == \"${DEP_NAME}\")).version = \"${WORKING_TREE_VERSION}\" | (.dependencies[] | select(.name == \"${DEP_NAME}\")).repository = \"file://${UNPACKED_CHART_DIR}\"" "${RENDER_C_DIR}/Chart.yaml"
  helm dependency update "${RENDER_C_DIR}" >/dev/null
  render_variant "${RENDER_C_DIR}" "${RENDER_C}"
else
  # Self-referential / self-test mode: <wrapper-dir> IS charts/shipwright, so
  # there's no separate dependency to swap. Render C is the working-tree
  # package templated directly (equivalent to templating charts/shipwright
  # itself, since the package step above packages exactly that working
  # tree) — this is the same general mechanism, degenerate because the
  # "wrapper" and the "dependency" are the same chart.
  render_variant "${UNPACKED_CHART_DIR}" "${RENDER_C}"
fi

# ---------------------------------------------------------------------------
# Diff logic
# ---------------------------------------------------------------------------

RENDER_A_NORM="${SCRATCH_DIR}/render-a.norm.yaml"
RENDER_B_NORM="${SCRATCH_DIR}/render-b.norm.yaml"
RENDER_C_NORM="${SCRATCH_DIR}/render-c.norm.yaml"
normalize_render "${RENDER_A}" "${RENDER_A_NORM}"
normalize_render "${RENDER_B}" "${RENDER_B_NORM}"
normalize_render "${RENDER_C}" "${RENDER_C_NORM}"

FAILED=false

echo "[check-downstream-compat] diffing A (wrapper as-is) vs B (published baseline)..."
AB_DIFF="${SCRATCH_DIR}/ab.diff"
if diff -u "${RENDER_A_NORM}" "${RENDER_B_NORM}" > "${AB_DIFF}"; then
  echo "[check-downstream-compat] A vs B: identical."
else
  # Allowlist image-tag-only diff lines: a '-'/'+' pair of lines is allowed
  # through if, after stripping a trailing image-tag value (the part after
  # the last ':' on an "image:" line), the two lines are identical.
  OFFENDING="${SCRATCH_DIR}/ab.offending"
  : > "${OFFENDING}"
  python3 - "${AB_DIFF}" "${OFFENDING}" <<'PYEOF'
import re
import sys

diff_path, out_path = sys.argv[1], sys.argv[2]
with open(diff_path) as f:
    lines = f.readlines()

# Collect contiguous +/- blocks (hunks of removed/added lines) and pair them
# positionally to check for image-tag-only differences.
#
# The repo-reference group excludes '@' so digest-pinned images
# (image: repo@sha256:<hex>) never match here: greedily matching through an
# '@sha256:' segment would let two genuinely different digests normalize to
# the same "<repo>:<TAG>" placeholder, silently allowlisting a real content
# change. Lines that don't match fall through to image_tag_normalized()'s
# `return line` below and are compared verbatim, so a digest change is
# correctly treated as a real diff, not a normalized tag.
IMAGE_TAG_RE = re.compile(r'^(\s*(?:-\s*)?image:\s*(?:(?!@)\S)+):[^:\s]+(\s*)$')

def image_tag_normalized(line):
    m = IMAGE_TAG_RE.match(line)
    if m:
        return m.group(1) + ":<TAG>" + m.group(2)
    return line

offending = []
i = 0
while i < len(lines):
    line = lines[i]
    if line.startswith('-') and not line.startswith('---'):
        removed = []
        j = i
        while j < len(lines) and lines[j].startswith('-') and not lines[j].startswith('---'):
            removed.append(lines[j])
            j += 1
        added = []
        k = j
        while k < len(lines) and lines[k].startswith('+') and not lines[k].startswith('+++'):
            added.append(lines[k])
            k += 1
        if len(removed) == len(added):
            for r, a in zip(removed, added):
                r_body = r[1:]
                a_body = a[1:]
                if image_tag_normalized(r_body) != image_tag_normalized(a_body):
                    offending.append(r)
                    offending.append(a)
        else:
            offending.extend(removed)
            offending.extend(added)
        i = k
    else:
        i += 1

with open(out_path, 'w') as f:
    f.writelines(offending)
PYEOF
  if [[ -s "${OFFENDING}" ]]; then
    echo "ERROR: A vs B has non-image-tag differences:" >&2
    echo "-------------------------------------------------------------" >&2
    cat "${OFFENDING}" >&2
    echo "-------------------------------------------------------------" >&2
    echo "Full diff: ${AB_DIFF}" >&2
    FAILED=true
  else
    echo "[check-downstream-compat] A vs B: only image-tag differences (allowlisted)."
  fi
fi

echo "[check-downstream-compat] diffing B (published baseline) vs C (working tree)..."
BC_DIFF="${SCRATCH_DIR}/bc.diff"
if diff -u "${RENDER_B_NORM}" "${RENDER_C_NORM}" > "${BC_DIFF}"; then
  echo "[check-downstream-compat] B vs C: identical."
else
  echo "ERROR: B vs C is not empty — the working-tree chart changes the wrapper's render relative to the published baseline (no allowlist for this comparison):" >&2
  echo "-------------------------------------------------------------" >&2
  cat "${BC_DIFF}" >&2
  echo "-------------------------------------------------------------" >&2
  FAILED=true
fi

# ---------------------------------------------------------------------------
# Wrapper's own helm lint / helm template against its own values
# ---------------------------------------------------------------------------

echo "[check-downstream-compat] running helm lint on the wrapper..."
if ! helm lint "${WRAPPER_DIR}" "${VALUES_ARGS[@]}"; then
  echo "ERROR: helm lint failed for wrapper at ${WRAPPER_DIR}" >&2
  FAILED=true
fi

echo "[check-downstream-compat] running helm template on the wrapper (own values)..."
if ! render_variant "${WRAPPER_DIR}" /dev/null; then
  echo "ERROR: helm template failed for wrapper at ${WRAPPER_DIR}" >&2
  FAILED=true
fi

if [[ "${FAILED}" == "true" ]]; then
  echo "[check-downstream-compat] FAILED — see errors above." >&2
  exit 1
fi

echo "[check-downstream-compat] PASSED — wrapper is compatible with the published baseline and the working-tree chart."

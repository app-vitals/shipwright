#!/usr/bin/env bash
#
# .github/workflows/lib/chart-tag-utils.sh
#
# Shared tag-parsing and values.yaml pin logic used by chart-release.yml
# (stamps release tags into a scratch copy of values.yaml at publish time),
# check-chart-drift.yml (compares the published chart's pins against the latest
# git tags) and their shell tests. Contains ONLY function definitions, so
# sourcing it has no side effects.
#
# This file is sourced only — running it directly does nothing useful.
#
set -uo pipefail

# Maps a release tag prefix to its service key.
service_for_tag() {
  local tag="$1"
  case "$tag" in
    admin-v*) echo "admin" ;;
    metrics-v*) echo "metrics" ;;
    agent-v*) echo "agent" ;;
    task-store-v*) echo "task-store" ;;
    agent-chat-v*) echo "chat" ;;
    *) echo "" ;;
  esac
}

# The chat service is the exception to the git-tag model: its image is
# ghcr.io/app-vitals/agent-chat, published by app-vitals/agent at the same
# X.Y.Z as the platform release that this repo pins in agent/Dockerfile
# (PLATFORM_VERSION, rewritten by platform-release.yml on the platform-release
# dispatch). So its "release tag" is synthesized as agent-chat-vX.Y.Z from
# that pin, and the value written to chat.image.tag is the bare X.Y.Z (the
# image tag, with no prefix). Run from the repo root.
platform_chat_tag() {
  local version
  version=$(sed -n 's/^ARG PLATFORM_VERSION=//p' agent/Dockerfile 2>/dev/null | head -n1)
  [ -n "$version" ] && printf 'agent-chat-v%s\n' "$version"
  return 0
}

# Prints the latest release tag for a service: the highest-semver
# "{service}-v*" git tag, except chat (see platform_chat_tag). Prints nothing
# when the service has no release tag yet.
latest_tag_for_service() {
  local service="$1" tags
  if [ "$service" = "chat" ]; then
    platform_chat_tag
    return 0
  fi
  tags=$(git tag -l "${service}-v*")
  [ -z "$tags" ] && return 0
  highest_semver_tag $tags
}

# Maps a release tag to the value written into values.yaml: the tag itself,
# except agent-chat-vX.Y.Z whose image tag is the bare X.Y.Z.
pin_value_for_tag() {
  local tag="$1"
  case "$tag" in
    agent-chat-v*) echo "${tag#agent-chat-v}" ;;
    *) echo "$tag" ;;
  esac
}

# Maps a service key to the values.yaml dot-paths that must be pinned to its
# released tag, one path per line. The agent service pins two paths from the
# same agent-v* tag: the top-level agent image and the admin-provisioned
# agent image nested under agent.provisioning.
values_paths_for_service() {
  local service="$1"
  case "$service" in
    admin) printf '%s\n' "admin.image.tag" ;;
    metrics) printf '%s\n' "metrics.image.tag" ;;
    agent) printf '%s\n' "agent.image.tag" "agent.provisioning.image.tag" ;;
    task-store) printf '%s\n' "taskStore.image.tag" ;;
    chat) printf '%s\n' "chat.image.tag" ;;
    *) return 1 ;;
  esac
}

# Returns the highest-semver tag among the given tags (space-separated, all
# sharing the same prefix). Strips the non-numeric prefix so `sort -V`
# compares the bare X.Y.Z portion, then re-attaches the winning original tag.
# A single-tag input is a no-op — the sole tag always "wins".
highest_semver_tag() {
  local tag
  for tag in "$@"; do
    printf '%s %s\n' "${tag##*-v}" "$tag"
  done | sort -V | tail -n1 | cut -d' ' -f2-
}

# Reads the value pinned at `dot_path` (e.g. "agent.provisioning.image.tag")
# inside `values_yaml`. Walks the key chain top-down using 2-space-indent
# scoping — the same structural assumption as update_values_tag() below — so agent.image.tag and agent.provisioning.image.tag
# resolve independently even though both lines read "tag: agent-v...".
# Prints nothing (empty string) if the path isn't found.
#
# Generic values.yaml dot-path reader — no drift-specific meaning of its own.
# Used by check-chart-drift.yml (via lib/chart-drift-check.sh's
# compute_drift()) and the chart-release tests.
read_pinned_tag() {
  local values_yaml="$1"
  local dot_path="$2"
  awk -v dot_path="$dot_path" '
    BEGIN {
      n = split(dot_path, keys, ".")
      depth = 0
      target_indent = 0
      in_scope = 1
    }
    {
      line = $0
      # Compute leading-space indentation.
      indent = 0
      while (substr(line, indent + 1, 1) == " ") indent++
      stripped = line
      sub(/^ +/, "", stripped)

      if (in_scope == 0) next

      # Once we have matched all keys but the last, we are inside the final
      # blocks scope; look for the last key at target_indent.
      if (depth == n - 1) {
        if (indent < target_indent) { in_scope = 0; next }
        if (indent != target_indent) next
        key = keys[depth + 1]
        if (stripped == key ":" || index(stripped, key ":") == 1) {
          val = stripped
          sub("^" key ":[ ]*", "", val)
          print val
          exit
        }
        next
      }

      # Still matching an intermediate key: must appear at target_indent.
      if (indent < target_indent) { in_scope = 0; next }
      if (indent != target_indent) next
      key = keys[depth + 1]
      if (stripped == key ":" || index(stripped, key ":") == 1) {
        depth++
        target_indent += 2
      }
    }
  ' "$values_yaml"
}

# Writes `tag` into the value at `dot_path` (e.g. "agent.provisioning.image.tag")
# inside `values_yaml`, matching only the `tag:` line nested under the exact
# chain of parent keys (indentation-scoped) — never a blind global regex, so
# agent.image.tag and agent.provisioning.image.tag can be updated
# independently even though both lines read "tag: agent-v...". Uses python3.
update_values_tag() {
  local values_yaml="$1"
  local dot_path="$2"
  local new_tag="$3"
  python3 - "$values_yaml" "$dot_path" "$new_tag" <<'PYEOF'
import sys

path, dot_path, new_tag = sys.argv[1], sys.argv[2], sys.argv[3]
keys = dot_path.split('.')

with open(path, 'r') as f:
    lines = f.readlines()

# Walk the key chain top-down. Each key must be found at exactly one
# indentation level deeper than the previous key, searching only within the
# span of lines that belongs to the previous key's block (up to the next
# line at the same-or-shallower indentation).
search_start, search_end = 0, len(lines)
indent = -1
for depth, key in enumerate(keys):
    is_last = depth == len(keys) - 1
    target_indent = indent + 2 if indent >= 0 else 0
    found_at = None
    for i in range(search_start, search_end):
        line = lines[i]
        stripped = line.lstrip(' ')
        this_indent = len(line) - len(stripped)
        if this_indent < target_indent:
            break
        if this_indent != target_indent:
            continue
        key_match = stripped.rstrip('\n') == f'{key}:' or stripped.startswith(f'{key}:')
        if key_match:
            found_at = i
            break
    if found_at is None:
        raise SystemExit(f'path segment {key!r} not found for dot_path {dot_path!r}')
    if is_last:
        lines[found_at] = f'{" " * target_indent}{key}: {new_tag}\n'
    else:
        # Narrow the search window to this key's own block: from the next
        # line up to (not including) the next line at <= this indentation.
        block_start = found_at + 1
        block_end = search_end
        for j in range(block_start, search_end):
            j_stripped = lines[j].lstrip(' ')
            if j_stripped.strip() == '':
                continue
            j_indent = len(lines[j]) - len(j_stripped)
            if j_indent <= target_indent:
                block_end = j
                break
        search_start, search_end = block_start, block_end
        indent = target_indent

with open(path, 'w') as f:
    f.writelines(lines)
PYEOF
}

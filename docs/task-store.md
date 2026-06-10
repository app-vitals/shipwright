# Task Store

The Shipwright task store is the backing database for the plan-execute-review loop. It holds all tasks, their statuses, dependencies, and metadata. Three backends are available:

| Backend | Where tasks live | Best for |
|---------|-----------------|---------|
| `json` | `state/todos.json` (local file) | Local development, offline use |
| `github` | GitHub Issues in a repo | Team collaboration with GitHub as the source of truth |
| `jira` | Jira project issues | Teams already using Jira for project tracking |

Config is resolved at startup using a three-step discovery chain:

1. Walk up from `cwd` looking for `.shipwright.json`
2. Fall back to the `SHIPWRIGHT_CONFIG` env var (path to a JSON config file)
3. Default to the JSON backend (no config needed)

> **Note for agent deployments:** Standard agent deployments configure the task store via env vars managed through the admin service — `.shipwright.json` is a local fallback for running the plugin outside the agent (e.g. manual CLI use or local development). You do not need a `.shipwright.json` for a production agent.

---

## JSON backend (default)

The JSON backend requires no configuration. When no `.shipwright.json` is found and `SHIPWRIGHT_CONFIG` is not set, Shipwright automatically uses `state/todos.json` in the process working directory.

### Quick start

```bash
# Initialize the task file (creates state/todos.json with an empty array)
bun plugins/shipwright/scripts/task_store.ts setup

# Confirm everything is healthy
bun plugins/shipwright/scripts/task_store.ts doctor
```

Expected `doctor` output:

```
backend: json
config: default (no SHIPWRIGHT_CONFIG set)
token scope: N/A (JSON backend)
[ok]  storage: /path/to/state/todos.json present
```

### When to use

- Getting started locally without any external accounts
- Single-developer workflows where the task queue doesn't need to be shared
- Offline environments

### Notes

- `state/todos.json` is git-ignored by default — it is a local queue, not a shared artifact
- Writes are atomic (temp-file rename)
- The JSON backend has no GitHub access, so cross-branch `pr_open` dependency checks are conservatively treated as unsatisfied

---

## GitHub backend

The GitHub backend stores tasks as GitHub Issues. Each issue carries a `status:*` label that is the authoritative status, plus a fenced `shipwright` code block in the issue body containing the full task metadata JSON.

### Prerequisites

- The `gh` CLI installed and authenticated (`gh auth login`)
- `GH_TOKEN` set if using a service account or CI environment (the `gh` CLI picks this up automatically)
- Write access to the target repo (needed for label creation and issue management)

### Configuration

Create `.shipwright.json` in your repo root (or any directory in the walk-up path):

```json
{
  "taskStore": "github",
  "github": {
    "owner": "your-org",
    "repo": "your-repo"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `taskStore` | yes | Must be `"github"` |
| `github.owner` | yes | GitHub organization or user name |
| `github.repo` | yes | Repository name |

### Quick start

```bash
# One-time setup: create the status:* labels in the repo
bun plugins/shipwright/scripts/task_store.ts setup

# Confirm the backend is active and the config is correct
bun plugins/shipwright/scripts/task_store.ts doctor
```

The `setup` command creates all `status:*` labels (`status:pending`, `status:in_progress`, `status:pr_open`, etc.) using `--force` so it is safe to re-run.

### When to use

- Team workflows where engineers need to see and update task status via GitHub
- Projects where the task queue should be visible alongside PRs and issues
- CI pipelines that already have `GH_TOKEN` available

---

## Jira backend

The Jira backend stores tasks as Jira issues. Each issue is tagged with the `shipwright-session` label so Shipwright can find them, and task metadata is stored in an ADF `codeBlock` with language `"shipwright"` inside the issue description. Issues without a `shipwright` code block in their description are ignored.

### Prerequisites

1. A Jira Cloud instance (the adapter uses the Jira REST API v3)
2. A Jira project with a known project key (e.g. `SHIP`)
3. An Atlassian API token — generate one at <https://id.atlassian.com/manage-profile/security/api-tokens>
4. The project must use the `shipwright-session` label to mark Shipwright-managed issues (the adapter applies this label automatically when it creates issues)

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_EMAIL` | yes | Email address of the Atlassian account associated with the API token |
| `JIRA_API_TOKEN` | yes | Atlassian API token (not your account password) |

Authentication uses HTTP Basic: `base64(JIRA_EMAIL:JIRA_API_TOKEN)`.

### Configuration

Create `.shipwright.json` in your repo root:

```json
{
  "taskStore": "jira",
  "jira": {
    "baseUrl": "https://yourorg.atlassian.net",
    "projectKey": "SHIP"
  }
}
```

Full example with all optional fields:

```json
{
  "taskStore": "jira",
  "jira": {
    "baseUrl": "https://yourorg.atlassian.net",
    "projectKey": "SHIP",
    "readyJql": "project = \"SHIP\" AND labels = \"shipwright-session\" AND status = \"To Do\" ORDER BY created ASC",
    "statusMap": {
      "Waiting": "pending",
      "In Development": "in_progress",
      "Code Review": "pr_open"
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `taskStore` | yes | Must be `"jira"` |
| `jira.baseUrl` | yes | Base URL of your Jira instance (no trailing slash) |
| `jira.projectKey` | yes | Jira project key, e.g. `SHIP` |
| `jira.readyJql` | no | Custom JQL to find tasks; overrides the default query (see below) |
| `jira.statusMap` | no | Override or extend the default Jira→Shipwright status mapping |

### Default status map

Shipwright maps Jira status names to its internal `TaskStatus` values. Custom entries in `statusMap` are merged over these defaults — you only need to specify statuses that differ from the defaults.

| Jira status | Shipwright status |
|-------------|------------------|
| `To Do` | `pending` |
| `Backlog` | `pending` |
| `Open` | `pending` |
| `In Progress` | `in_progress` |
| `In Review` | `pr_open` |
| `PR Open` | `pr_open` |
| `Done` | `done` |
| `Closed` | `done` |
| `Resolved` | `done` |
| `Blocked` | `blocked` |
| `On Hold` | `blocked` |
| `Won't Do` | `cancelled` |
| `Cancelled` | `cancelled` |

If your Jira project uses non-standard status names, add them to `statusMap`. For example, if your project uses `"In Development"` instead of `"In Progress"`:

```json
{
  "jira": {
    "statusMap": {
      "In Development": "in_progress"
    }
  }
}
```

### Default JQL query

When `readyJql` is not set, the adapter fetches issues using:

```
project = "PROJECT_KEY" AND labels = "shipwright-session" ORDER BY created ASC
```

The `readyJql` field overrides this entire query. Use it to narrow scope (e.g. a specific sprint or fix version), add status filters, or change the sort order.

Example — limit to the current sprint and only pending tasks:

```json
{
  "jira": {
    "readyJql": "project = \"SHIP\" AND labels = \"shipwright-session\" AND sprint in openSprints() AND status = \"To Do\" ORDER BY created ASC"
  }
}
```

### How task metadata is stored

When Shipwright creates a Jira issue, it stores the full task JSON in an ADF `codeBlock` with `language: "shipwright"` in the issue description. A human-readable description paragraph appears above it. Issues without this block are ignored by the adapter.

Jira's own status field is authoritative for `TaskStatus` — it overrides whatever status value is stored in the metadata block. Status transitions are performed via the Jira transitions API using the same names as the status map.

### Quick start

```bash
# Export credentials
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="your-api-token"

# Create .shipwright.json (see above)

# Run setup to verify the project exists and credentials are valid
bun plugins/shipwright/scripts/task_store.ts setup

# Check diagnostics
bun plugins/shipwright/scripts/task_store.ts doctor
```

The `setup` command calls the Jira project API (`GET /rest/api/3/project/{key}`) and throws a clear error if auth fails or the project is not found. It does not create any Jira objects — Jira projects must be created through the Jira UI. The command is safe to re-run.

---

## Troubleshooting

### Jira: 401 Unauthorized

```
Jira auth failure (401): check JIRA_EMAIL and JIRA_API_TOKEN
```

Causes:
- `JIRA_EMAIL` does not match the Atlassian account that owns the API token
- `JIRA_API_TOKEN` is copied incorrectly (check for leading/trailing whitespace)
- The API token has been revoked — generate a new one at <https://id.atlassian.com/manage-profile/security/api-tokens>

### Jira: 403 Forbidden

```
Jira auth failure (403): check JIRA_EMAIL and JIRA_API_TOKEN
```

Causes:
- The Atlassian account does not have permission to access the project
- IP allowlisting is blocking the request (common in enterprise Jira instances)
- The account is a service account that lacks the Browse Projects permission

### Jira: 404 project not found

```
Jira project not found: "SHIP" — verify jira.projectKey in your config
```

Causes:
- `jira.projectKey` in `.shipwright.json` does not match the actual project key
- The project exists in a different Jira instance — verify `jira.baseUrl`
- The project has been archived or deleted

To find the correct project key: open the project in Jira and look at the URL (`/projects/KEY/...`) or go to **Project settings > Details**.

### Tasks not appearing

If `task_store.ts query --status pending` returns an empty array even though issues exist in Jira:

1. **Missing label** — Shipwright only queries issues tagged `shipwright-session`. Issues created outside of Shipwright will not be picked up unless you add this label manually.

2. **Missing metadata block** — Issues must contain a `shipwright` code block in their description. Issues without it are silently ignored. Check the issue description in Jira to confirm the block is present.

3. **JQL not matching** — If you have a custom `readyJql`, verify it returns the expected issues by running it directly in Jira's issue navigator. Check for typos in the project key or label name.

4. **Status not in map** — If your Jira project uses custom status names not in the default map (and not added to `statusMap`), tasks will default to `pending` regardless of the actual Jira status. This does not prevent tasks from appearing, but status-filtered queries may behave unexpectedly.

5. **Wrong backend active** — Run `bun plugins/shipwright/scripts/task_store.ts doctor` to confirm the Jira backend is active. If it reports `backend: json`, the `.shipwright.json` file is not being discovered. Check that the file is in the current directory or a parent directory, and that the JSON is valid.

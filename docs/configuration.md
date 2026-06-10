# Configuration

Shipwright can be configured entirely via environment variables — no `.shipwright.json`
file required. This is the recommended approach for managed agent deployments.

---

## Config resolution order

| Priority | Source | When it applies |
|----------|--------|----------------|
| 1 (highest) | Env vars (`SHIPWRIGHT_TASK_STORE`, …) | When `SHIPWRIGHT_TASK_STORE` is set |
| 2 | `.shipwright.json` file | When found by walking up from cwd |
| 3 | `SHIPWRIGHT_CONFIG` env var | Path to a JSON config file |
| 4 (lowest) | Default | Falls back to JSON backend |

Env vars always win. If `SHIPWRIGHT_TASK_STORE` is set, the file walk-up and
`SHIPWRIGHT_CONFIG` are skipped entirely.

---

## Environment variables

### Task store selection

| Variable | Values | Description |
|----------|--------|-------------|
| `SHIPWRIGHT_TASK_STORE` | `github`, `jira`, `json` | Selects the task store backend. When set, takes precedence over all file-based config. |

### GitHub backend

Set `SHIPWRIGHT_TASK_STORE=github` plus:

| Variable | Required | Description |
|----------|----------|-------------|
| `SHIPWRIGHT_GITHUB_OWNER` | yes | GitHub organization or user name |
| `SHIPWRIGHT_GITHUB_REPO` | yes | Repository name |

The `gh` CLI must be authenticated. Set `GH_TOKEN` for service accounts or CI
environments.

**Example:**

```bash
export SHIPWRIGHT_TASK_STORE=github
export SHIPWRIGHT_GITHUB_OWNER=my-org
export SHIPWRIGHT_GITHUB_REPO=my-repo
```

### Jira backend

Set `SHIPWRIGHT_TASK_STORE=jira` plus:

| Variable | Required | Description |
|----------|----------|-------------|
| `JIRA_BASE_URL` | yes | Base URL of your Jira instance, e.g. `https://example.atlassian.net` |
| `JIRA_PROJECT_KEY` | yes | Jira project key, e.g. `SHIP` |
| `JIRA_EMAIL` | yes | Email for Atlassian Basic Auth |
| `JIRA_API_TOKEN` | yes | Atlassian API token |

**Example:**

```bash
export SHIPWRIGHT_TASK_STORE=jira
export JIRA_BASE_URL=https://example.atlassian.net
export JIRA_PROJECT_KEY=SHIP
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=your-api-token
```

### Config file override

| Variable | Description |
|----------|-------------|
| `SHIPWRIGHT_CONFIG` | Absolute path to a `.shipwright.json`-format config file. Used when no `.shipwright.json` is found by the walk-up and `SHIPWRIGHT_TASK_STORE` is not set. |

---

## File-based config (`.shipwright.json`)

For local development or repos where a checked-in config is preferred, create
`.shipwright.json` in the repo root (or any directory in the walk-up path):

```json
{
  "taskStore": "github",
  "github": {
    "owner": "my-org",
    "repo": "my-repo"
  }
}
```

See [docs/task-store.md](task-store.md) for the full schema and per-backend options.

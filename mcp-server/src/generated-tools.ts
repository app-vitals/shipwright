// GENERATED FILE — do not edit by hand.
// Produced by scripts/generate-mcp-tools.ts from task-store/openapi.json.
// Regenerate with: bun run generate:mcp-tools

/** An MCP tool derived from a single task-store OpenAPI operation. */
export interface GeneratedTool {
  /** snake_case tool name, e.g. "tasks_list". */
  name: string;
  /** Human-readable description (from the OpenAPI operation summary). */
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
  /** HTTP method to call on the task-store API. */
  method: string;
  /** Original OpenAPI path template, e.g. "/tasks/{id}/claim". */
  pathTemplate: string;
  /** Names of query-string parameters. */
  queryParams: string[];
  /** Names of path parameters (substituted into pathTemplate). */
  pathParams: string[];
  /** True if the operation accepts a JSON request body. */
  hasBody: boolean;
  /** True when the request body is a JSON array (not an object).
   * The input schema exposes an `items` property of type `array`;
   * `callTool` sends `args.items` directly as the body. */
  hasArrayBody?: boolean;
}

export const generatedTools: GeneratedTool[] = [
  {
    name: "tasks_list",
    description: "List tasks",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          example: "pending",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "in_progress", "ready", "blocked"],
          example: "open",
        },
        source: {
          type: "string",
          example: "entropy-fix",
        },
        session: {
          type: "string",
          example: "session-123",
        },
        repo: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
          example: "org/repo",
          description:
            "Filter by repo (`org/repo` format). Repeatable — pass `?repo=` multiple times to match any repo in the list (e.g. `?repo=org/a&repo=org/b`). A single `?repo=` behaves identically to before (exact match).",
        },
        org: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
          example: "org",
          description:
            "Filter by org — matches any repo whose `org/repo` string starts with `<org>/`. Repeatable — pass `?org=` multiple times to match any of several orgs. Combines with `repo` as an AND filter.",
        },
        assignee: {
          type: "string",
          example: "user@example.com",
        },
        claimedBy: {
          type: "string",
          example: "agent-id-123",
        },
        branch: {
          type: "string",
          example: "feat/feature-x",
        },
        pr: {
          type: "string",
          example: "42",
        },
        limit: {
          type: "string",
          example: "50",
        },
        offset: {
          type: "string",
          example: "0",
        },
        ready: {
          type: "string",
          enum: ["true", "false"],
          example: "true",
        },
        accountId: {
          type: "string",
          example: "default",
          description:
            "Admin tokens only: narrow results to one account. Ignored for agent tokens, which are always pinned to their own account.",
        },
        hitl: {
          type: "string",
          enum: ["true", "false"],
          example: "true",
        },
        kind: {
          type: "string",
          enum: ["dev", "prd", "initiative", "idea"],
          example: "prd",
          description:
            "Filter by TaskKind. Combines with every other filter as an AND. Note `?kind=<prd|initiative|idea>&ready=true` is always empty — ready.ts excludes every non-dev kind structurally.",
        },
        sort: {
          type: "string",
          enum: ["asc", "desc"],
          example: "asc",
        },
        updatedSince: {
          type: "string",
          example: "2026-01-01T00:00:00.000Z",
          description:
            "Only return tasks with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tasks",
    queryParams: [
      "status",
      "state",
      "source",
      "session",
      "repo",
      "org",
      "assignee",
      "claimedBy",
      "branch",
      "pr",
      "limit",
      "offset",
      "ready",
      "accountId",
      "hitl",
      "kind",
      "sort",
      "updatedSince",
    ],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "tasks_create",
    description: "Create a task",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          example: "Implement feature X",
        },
        status: {
          type: "string",
          minLength: 1,
          example: "pending",
        },
        repo: {
          type: ["string", "null"],
          example: "org/repo",
        },
        session: {
          type: "string",
          example: "session-123",
        },
        description: {
          type: "string",
          example: "Task description",
        },
        layer: {
          type: "string",
          example: "service",
        },
        branch: {
          type: "string",
          example: "feat/feature-x",
        },
        pr: {
          example: 42,
          description:
            'PR number. Accepts a positive integer, an integer string (`"42"`), or a github.com pull-request URL (`https://github.com/<owner>/<repo>/pull/<n>`); stored as the integer. Any other value is rejected with 400 by the handler (not the schema, so the error message names the accepted forms).',
        },
        dependencies: {
          type: "array",
          items: {
            type: "string",
          },
          example: [],
        },
        acceptanceCriteria: {
          type: "array",
          items: {
            type: "string",
          },
          example: [],
        },
        assignee: {
          type: "string",
          example: "user@example.com",
        },
        priority: {
          type: "string",
          example: "high",
        },
        type: {
          type: "string",
          example: "feature",
        },
        source: {
          type: "string",
          example: "manual",
        },
        kind: {
          type: "string",
          enum: ["dev", "prd", "initiative", "idea"],
          example: "dev",
          description: "What the task is (TKD-1.1). Defaults to `dev`.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks",
    queryParams: [],
    pathParams: [],
    hasBody: true,
  },
  {
    name: "tasks_bulk",
    description: "Bulk insert tasks",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Array of items to submit as the request body.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                minLength: 1,
                example: "Implement feature X",
              },
              status: {
                type: "string",
                minLength: 1,
                example: "pending",
              },
              repo: {
                type: ["string", "null"],
                example: "org/repo",
              },
              pr: {
                example: 42,
                description:
                  'PR number. Accepts a positive integer, an integer string (`"42"`), or a github.com pull-request URL (`https://github.com/<owner>/<repo>/pull/<n>`); stored as the integer. Any other value is rejected with 400 by the handler (not the schema, so the error message names the accepted forms).',
              },
            },
            additionalProperties: {},
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/bulk",
    queryParams: [],
    pathParams: [],
    hasBody: true,
    hasArrayBody: true,
  },
  {
    name: "tasks_by_pr",
    description: "Mark merged tasks deployed or released by PR number",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          minLength: 1,
          example: "org/repo",
        },
        prNumbers: {
          type: "array",
          items: {
            type: "integer",
            exclusiveMinimum: 0,
          },
          minItems: 1,
          maxItems: 100,
          example: [101, 102],
          description: "PR numbers of `repo`, 1 to 100 positive integers.",
        },
        status: {
          type: "string",
          enum: ["deployed", "released"],
          example: "deployed",
        },
        at: {
          type: "string",
          minLength: 1,
          example: "2026-07-02T00:00:00.000Z",
          description:
            "ISO timestamp stamped into deployedAt/releasedAt. Defaults to now.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "PATCH",
    pathTemplate: "/tasks/by-pr",
    queryParams: [],
    pathParams: [],
    hasBody: true,
  },
  {
    name: "tasks_distinct",
    description: "Get distinct session and repo values",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tasks/distinct",
    queryParams: [],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "tasks_get",
    description: "Get a task by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tasks/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tasks_update",
    description: "Update a task",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
        pr: {
          example: 42,
          description:
            'PR number. Accepts a positive integer, an integer string (`"42"`), or a github.com pull-request URL (`https://github.com/<owner>/<repo>/pull/<n>`); stored as the integer. Any other value is rejected with 400 by the handler (not the schema, so the error message names the accepted forms).',
        },
        kind: {
          type: "string",
          enum: ["dev", "prd", "initiative", "idea"],
          example: "initiative",
          description:
            "Change what the task is (INI-1.1) — e.g. promote an `idea` to an `initiative`, or an `initiative` to `dev`.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "PATCH",
    pathTemplate: "/tasks/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "tasks_delete",
    description: "Delete a task",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "DELETE",
    pathTemplate: "/tasks/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tasks_claim",
    description: "Atomically claim a task",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
        claimedBy: {
          type: "string",
          example: "agent-id-123",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/claim",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "tasks_heartbeat",
    description: "Touch heartbeatAt on a claimed task",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/heartbeat",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tasks_complete",
    description: "Mark a task as done",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/complete",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tasks_fail",
    description: "Mark a task as blocked",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
        reason: {
          type: "string",
          example: "build failed",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/fail",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "tasks_release",
    description: "Release a task back to pending",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/release",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tasks_skip",
    description:
      "Record a skip — increments skipCount, auto-blocks at threshold",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
        reason: {
          type: "string",
          example: "dev-task:deferred:unmet-hidden-requirement",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/skip",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "tasks_reset",
    description: "Reset skip tracking — skipCount back to 0",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/skip/reset",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tasks_unblock",
    description:
      "Atomically unblock a task to pending, pr_open, merged, deployed or released",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
        to: {
          type: "string",
          enum: ["pending", "pr_open", "merged", "deployed", "released"],
          description:
            "Target status. Omit to infer from task.pr and the PR record (never deployed/released).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/unblock",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "tasks_events",
    description:
      "Fetch a task's TaskEvent audit trail, ordered by `at` ascending (oldest first)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx1234567890",
        },
        limit: {
          type: "string",
          example: "50",
          description: "Max records to return",
        },
        offset: {
          type: "string",
          example: "0",
          description: "Pagination offset",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tasks/{id}/events",
    queryParams: ["limit", "offset"],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "tokens_list",
    description: "List all tokens",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tokens",
    queryParams: [],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "tokens_create",
    description: "Create a new token — raw value returned exactly once",
    inputSchema: {
      type: "object",
      properties: {
        label: {
          type: "string",
          example: "ci-runner",
        },
        agentId: {
          type: "string",
          example: "agent-id-123",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tokens",
    queryParams: [],
    pathParams: [],
    hasBody: true,
  },
  {
    name: "tokens_update",
    description: "Update token label and/or agentId",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clxtoken123456",
        },
        label: {
          type: "string",
          example: "ci-runner",
        },
        agentId: {
          type: "string",
          example: "agent-id-123",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "PATCH",
    pathTemplate: "/tokens/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "tokens_delete",
    description: "Revoke a token",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clxtoken123456",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "DELETE",
    pathTemplate: "/tokens/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_list",
    description: "List pull requests",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
          example: "org/repo",
          description:
            "Filter by repo. Repeatable (?repo=a&repo=b) to match any of several repos.",
        },
        org: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
          example: "org",
          description:
            "Filter by org — matches repos whose 'org/repo' starts with '<org>/'. Repeatable (?org=a&org=b) to match any of several orgs. Composable with repo (AND).",
        },
        prNumber: {
          type: "string",
          example: "42",
          description: "PR number (parsed as integer)",
        },
        state: {
          type: "string",
          enum: ["open", "merged", "closed"],
          example: "open",
        },
        reviewState: {
          type: "string",
          enum: ["pending", "in_progress", "posted", "approved"],
          example: "pending",
        },
        staged: {
          type: "string",
          enum: ["true", "false"],
          example: "false",
          description: "Filter by staged flag",
        },
        limit: {
          type: "string",
          example: "50",
          description: "Max records to return",
        },
        offset: {
          type: "string",
          example: "0",
          description: "Pagination offset",
        },
        ready: {
          type: "string",
          enum: ["true", "false"],
          example: "true",
          description:
            "When true, return only unclaimed PRs (claimedBy IS NULL) — mirrors /tasks?ready=true. Composable with other filters (repo, state, reviewState); does not itself apply state/reviewState eligibility rules the way claim-next does.",
        },
        blocked: {
          type: "string",
          enum: ["true", "false"],
          example: "true",
          description:
            "When true, return only PRs considered blocked: pr.blocked===true OR (linked task exists AND task.status==='blocked'). Task.hitl is not consulted — post-redesign, Type A tasks (the only ones that keep hitl:true) never have a linked PR. Composable with other filters (e.g. state=open).",
        },
        sort: {
          type: "string",
          enum: ["asc", "desc"],
          example: "asc",
          description:
            "Order results by createdAt. Default is ascending (asc), preserving current behavior for existing callers. Unrelated to claim-next's own deterministic ordering.",
        },
        updatedSince: {
          type: "string",
          example: "2026-01-01T00:00:00.000Z",
          description:
            "Only return PRs with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
        },
        origin: {
          type: "string",
          example: "shipwright,ci",
          description:
            "Comma-separated list of PrOrigin values (shipwright, ci, dependency_bot, human, unknown). Matches rows whose origin is any of the given values.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/prs",
    queryParams: [
      "repo",
      "org",
      "prNumber",
      "state",
      "reviewState",
      "staged",
      "limit",
      "offset",
      "ready",
      "blocked",
      "sort",
      "updatedSince",
      "origin",
    ],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "prs_claim",
    description: "Claim a pull request (atomic)",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          example: "org/repo",
          description: "Repository in org/repo format",
        },
        prNumber: {
          type: "integer",
          example: 42,
          description: "Pull request number",
        },
        commitSha: {
          type: "string",
          example: "abc123def456",
          description: "Commit SHA to associate",
        },
        claimedBy: {
          type: "string",
          example: "agent-id-123",
          description: "Agent claiming this PR (admin tokens only)",
        },
        phase: {
          type: "string",
          enum: ["review", "patch", "merge"],
          example: "patch",
          description:
            "Pipeline phase this claim is for (defaults to 'review' when omitted)",
        },
        prCreatedAt: {
          type: "string",
          example: "2026-01-01T00:00:00.000Z",
          description:
            "ISO timestamp of the GitHub PR's actual creation time. Only applied on first claim (record creation); ignored on subsequent claims since the field is immutable once set.",
        },
        authorLogin: {
          type: ["string", "null"],
          example: "octocat",
          description:
            "PR author's GitHub login (POM-1.2). Used server-side to derive `origin` (first-write-wins) and refreshed unconditionally on every claim.",
        },
        headRef: {
          type: ["string", "null"],
          example: "feat/some-branch",
          description:
            "PR's head branch name (POM-1.2). Used server-side to derive `origin` (first-write-wins) and refreshed unconditionally on every claim.",
        },
        title: {
          type: ["string", "null"],
          example: "Add the origin metrics dimension",
          description:
            "PR title (POM-1.2). Refreshed unconditionally on every claim.",
        },
        authorIsBot: {
          type: "boolean",
          example: true,
          description:
            "True when the caller's GitHub client reports `is_bot: true` for the PR author (POF-1.1), e.g. `gh pr list --json author` normalizing a bot author to `app/<slug>`. Used server-side to derive `origin`, checked ahead of the legacy `authorLogin` string matching.",
        },
        hasAutomatedLabel: {
          type: "boolean",
          example: false,
          description:
            "True when the PR carries a label indicating CI/automation opened it (POF-1.1). Used server-side to derive `origin='ci'`, independent of `authorLogin`.",
        },
        hasShipwrightLabel: {
          type: "boolean",
          example: false,
          description:
            "True when the PR carries a label indicating Shipwright itself opened it (POF-1.1). Used server-side to derive `origin='shipwright'` at the same precedence step as a linked Task row — no linked task is required.",
        },
      },
      required: ["repo", "prNumber", "commitSha"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/claim",
    queryParams: [],
    pathParams: [],
    hasBody: true,
  },
  {
    name: "prs_claim_next",
    description: "Atomic find-and-claim of oldest eligible PR",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          example: "agent-id-123",
          description:
            "Agent ID (admin tokens only; agent tokens use token identity)",
        },
        maxConcurrent: {
          type: "integer",
          example: 1,
          description: "Maximum concurrent PRs to claim",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/claim-next",
    queryParams: [],
    pathParams: [],
    hasBody: true,
  },
  {
    name: "prs_census",
    description: "Batch upsert PR origin/author/branch/title/state metadata",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Array of items to submit as the request body.",
          items: {
            $ref: "#/components/schemas/CensusEntry",
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/census",
    queryParams: [],
    pathParams: [],
    hasBody: true,
    hasArrayBody: true,
  },
  {
    name: "prs_cursor",
    description: "Get the census incremental-search-window cursor for a repo",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          example: "org/repo",
          description: "Repository in org/repo format.",
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/prs/census/cursor",
    queryParams: ["repo"],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "prs_get",
    description: "Fetch a single pull request",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/prs/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_update",
    description: "Update pull request fields",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "PATCH",
    pathTemplate: "/prs/{id}",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "prs_heartbeat",
    description: "Touch heartbeatAt for a claimed PR",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/heartbeat",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_complete",
    description: "Mark PR review as complete (reviewState=posted)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/complete",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_patch",
    description:
      "Increment patchCycles and conditionally reset reviewState=pending; optionally track a CI-failure streak via ciFailureSignature",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
        commitSha: {
          type: "string",
          example: "abc123def456",
          description:
            "Current head commit SHA. When provided and it differs from the record's stored commitSha, reviewState resets to pending and commitSha is updated. When it matches, reviewState is left untouched (no-op patch cycle). When omitted, reviewState unconditionally resets to pending (legacy behavior).",
        },
        ciFailureSignature: {
          type: "string",
          example: "npm-test-failed-foo.unit.test.ts",
          description:
            "Signature identifying the current CI failure (e.g. which check + which test). When it matches the record's stored lastCiFailureSignature, consecutiveCiFailureCount increments; when it differs (or none is stored), the count resets to 1 and the new signature is stored. Crossing CI_FAILURE_BLOCK_THRESHOLD (3) auto-sets blocked:true plus a descriptive blockedReason. When omitted (e.g. merge-conflict/review-fix patch calls unrelated to CI), both fields are left untouched.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/patch",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "prs_release",
    description: "Release a claim (reviewState=pending, claimedBy cleared)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/release",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_skip",
    description:
      "Record a skip — increments skipCount, auto-blocks at threshold",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/skip",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_reset",
    description:
      "Reset skip tracking — skipCount back to 0; also clears blocked/blockedReason if the PR was blocked by the skip mechanism",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/skip/reset",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_unblock",
    description:
      "Unblock a blocked PR — atomically resets blocked, blockedReason, blockedHeadSha, skip tracking and the CI-failure streak",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/unblock",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "prs_findings",
    description:
      "Append a review/patch finding to a PR — source:'patch' may only submit disposition:'rejected'",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
        ref: {
          type: "string",
          example: "src/foo.ts:42",
          description: "Identifier for the finding (e.g. file:line or a slug).",
        },
        disposition: {
          type: "string",
          enum: ["resolved", "superseded", "rejected"],
          example: "resolved",
          description:
            "Triage outcome. source:'patch' may only submit 'rejected' — server-enforced (400 otherwise); source:'review' may submit any value.",
        },
        source: {
          type: "string",
          enum: ["review", "patch"],
          example: "review",
          description: "Which pipeline phase is recording this finding.",
        },
        evidence: {
          type: "string",
          example: "Fixed the null check in the follow-up commit.",
        },
        at: {
          type: "string",
          example: "2026-08-17T12:00:00.000Z",
          description:
            "ISO timestamp of when the finding was triaged. Defaults to the current time when omitted.",
        },
        agentId: {
          type: "string",
          example: "agent-abc123",
          description: "Agent instance that triaged this finding.",
        },
      },
      required: ["id", "ref", "disposition", "source", "evidence"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/prs/{id}/findings",
    queryParams: [],
    pathParams: ["id"],
    hasBody: true,
  },
  {
    name: "prs_events",
    description:
      "Fetch a PR's PullRequestEvent audit trail, ordered by `at` ascending (oldest first)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
        limit: {
          type: "string",
          example: "50",
          description: "Max records to return",
        },
        offset: {
          type: "string",
          example: "0",
          description: "Pagination offset",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/prs/{id}/events",
    queryParams: ["limit", "offset"],
    pathParams: ["id"],
    hasBody: false,
  },
  {
    name: "sessions_list",
    description: "List sessions",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["waiting", "active", "closed", "empty", "archived", "all"],
          example: "waiting",
          description:
            "Omitted: archived===false AND state!=='closed'. A named state (waiting/active/closed/empty) matches rollup.state alone (not additionally archived-filtered). 'archived': archived===true (rollup state ignored). 'all': no filtering.",
        },
        sort: {
          type: "string",
          enum: ["waitingSince", "lastActivityAt"],
          example: "waitingSince",
          description:
            "'waitingSince': waiting sessions first (oldest waitingSince first), then non-waiting sessions by lastActivityAt desc. Default (or 'lastActivityAt'): all sessions by lastActivityAt desc, nulls last.",
        },
        agentId: {
          type: "string",
          example: "agent-id-123",
          description:
            "Only sessions whose rollup.agentIds includes this agent.",
        },
        repo: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
          example: "org/repo",
          description:
            "Only sessions whose rollup.repos includes any of the given repo(s). Repeatable (?repo=a&repo=b).",
        },
        org: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "array",
              items: {
                type: "string",
              },
            },
          ],
          example: "org",
          description:
            "Only sessions with a repo whose `org/repo` string starts with `<org>/`. Repeatable — pass `?org=` multiple times to match any of several orgs (e.g. `?org=a&org=b`).",
        },
        q: {
          type: "string",
          example: "launch",
          description:
            "Case-insensitive substring match against slug OR title.",
        },
        accountId: {
          type: "string",
          example: "default",
          description:
            "Admin tokens only: restrict to one account's sessions. Omitted: every account's sessions, each labeled by `accountId`. Ignored for agent tokens, which are pinned to their own account.",
        },
        limit: {
          type: "string",
          example: "50",
        },
        offset: {
          type: "string",
          example: "0",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/sessions",
    queryParams: [
      "state",
      "sort",
      "agentId",
      "repo",
      "org",
      "q",
      "accountId",
      "limit",
      "offset",
    ],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "sessions_get",
    description: "Get a session by slug",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          example: "shipwright-may-launch",
        },
        accountId: {
          type: "string",
          example: "default",
          description:
            "Admin tokens only: the account whose session to address (default: 'default'). Ignored for agent tokens, which are pinned to their own account.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/sessions/{slug}",
    queryParams: ["accountId"],
    pathParams: ["slug"],
    hasBody: false,
  },
  {
    name: "sessions_update",
    description: "Rename/archive a session — admin-only",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          example: "shipwright-may-launch",
        },
        accountId: {
          type: "string",
          example: "default",
          description:
            "Admin tokens only: the account whose session to address (default: 'default'). Ignored for agent tokens, which are pinned to their own account.",
        },
        title: {
          type: ["string", "null"],
          example: "May launch prep",
          description:
            "Omitted: title untouched. A string: set. null: clears the title.",
        },
        archived: {
          type: "boolean",
          example: true,
          description:
            "Omitted: archive fields untouched. true: stamps archivedAt/archivedBy. false: clears both.",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    method: "PATCH",
    pathTemplate: "/sessions/{slug}",
    queryParams: ["accountId"],
    pathParams: ["slug"],
    hasBody: true,
  },
  {
    name: "verification-checks_list",
    description:
      "List verification checks for a task, a PR, or a repo+checkName pair",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          example: "clx1234567890",
          description:
            "Selects task mode. Exactly one of ?taskId=, ?prId=, or (?repo=+?checkName=) is required.",
        },
        prId: {
          type: "string",
          example: "clx0987654321",
        },
        repo: {
          type: "string",
          example: "org/repo",
          description:
            "Selects repo+checkName mode (LVB-4.4) — paired with ?checkName=, both required together. Returns history for this repo+check across ALL tasks/PRs, ordered by `at` DESCENDING (most recent first) — a deliberate deviation from the taskId/prId modes' ascending order, so a caller can walk backward from the most recent outcome to detect a consecutive skipped/timed_out streak.",
        },
        checkName: {
          type: "string",
          example: "unit",
          description:
            "Paired with ?repo= — supplying only one of the pair is 400.",
        },
        limit: {
          type: "string",
          example: "50",
          description: "Max records to return",
        },
        offset: {
          type: "string",
          example: "0",
          description: "Pagination offset",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/verification-checks",
    queryParams: ["taskId", "prId", "repo", "checkName", "limit", "offset"],
    pathParams: [],
    hasBody: false,
  },
  {
    name: "verification-checks_create",
    description: "Record a single per-check verification outcome",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          example: "clx1234567890",
          description:
            "Exactly one of taskId/prId is required — supplying neither or both is 400.",
        },
        prId: {
          type: "string",
          example: "clx0987654321",
        },
        repo: {
          type: "string",
          example: "org/repo",
        },
        checkName: {
          type: "string",
          example: "unit",
          description:
            "Free-form check name — 'install', 'lint', 'typecheck', 'unit', 'integration', etc.",
        },
        status: {
          type: "string",
          enum: ["ran_passed", "ran_failed", "skipped", "timed_out"],
          example: "ran_passed",
        },
        reasonCategory: {
          type: "string",
          enum: [
            "check_timeout",
            "install_timeout",
            "resource_limit",
            "missing_tool",
            "missing_secret",
            "missing_dependency",
            "not_configured",
            "learned_skip",
          ],
          example: "missing_tool",
          description:
            "Only valid alongside status: 'skipped' or 'timed_out'. A status:'ran_failed' (or 'ran_passed') request supplying this is 400.",
        },
        learnedFromCategory: {
          type: "string",
          enum: [
            "check_timeout",
            "install_timeout",
            "resource_limit",
            "missing_tool",
            "missing_secret",
            "missing_dependency",
            "not_configured",
            "learned_skip",
          ],
          example: "missing_tool",
          description:
            "Only valid alongside reasonCategory: 'learned_skip', and must not itself be 'learned_skip'.",
        },
        durationMs: {
          type: "integer",
          example: 4200,
        },
        at: {
          type: "string",
          example: "2026-09-24T12:00:00.000Z",
          description:
            "ISO timestamp of when the check completed. Defaults to the current time when omitted.",
        },
      },
      required: ["repo", "checkName", "status"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/verification-checks",
    queryParams: [],
    pathParams: [],
    hasBody: true,
  },
];

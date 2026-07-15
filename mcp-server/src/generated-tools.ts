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
        session: {
          type: "string",
          example: "session-123",
        },
        repo: {
          type: "string",
          example: "org/repo",
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
      },
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/tasks",
    queryParams: [
      "status",
      "state",
      "session",
      "repo",
      "assignee",
      "claimedBy",
      "branch",
      "pr",
      "limit",
      "offset",
      "ready",
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
            },
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
          type: "string",
          example: "org/repo",
        },
        prNumber: {
          type: "string",
          description: "PR number (parsed as integer)",
          example: "42",
        },
        taskId: {
          type: "string",
          example: "clx1234567890",
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
          description: "Filter by staged flag",
          example: "false",
        },
        limit: {
          type: "string",
          description: "Max records to return",
          example: "50",
        },
        offset: {
          type: "string",
          description: "Pagination offset",
          example: "0",
        },
        ready: {
          type: "string",
          enum: ["true", "false"],
          description:
            "When true, return only unclaimed PRs (claimedBy IS NULL) — mirrors /tasks?ready=true. Composable with other filters (repo, state, reviewState); does not itself apply state/reviewState eligibility rules the way claim-next does.",
          example: "true",
        },
        sort: {
          type: "string",
          enum: ["asc", "desc"],
          description:
            "Order results by createdAt. Default is ascending (asc), preserving current behavior for existing callers. Unrelated to claim-next's own deterministic ordering.",
          example: "asc",
        },
      },
      required: [],
      additionalProperties: false,
    },
    method: "GET",
    pathTemplate: "/prs",
    queryParams: [
      "repo",
      "prNumber",
      "taskId",
      "state",
      "reviewState",
      "staged",
      "limit",
      "offset",
      "ready",
      "sort",
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
          description: "Repository in org/repo format",
          example: "org/repo",
        },
        prNumber: {
          type: "integer",
          description: "Pull request number",
          example: 42,
        },
        commitSha: {
          type: "string",
          description: "Commit SHA to associate",
          example: "abc123def456",
        },
        claimedBy: {
          type: "string",
          description: "Agent claiming this PR (admin tokens only)",
          example: "agent-id-123",
        },
        taskId: {
          type: "string",
          description: "Associated task ID",
          example: "clx1234567890",
        },
        phase: {
          type: "string",
          enum: ["review", "patch", "deploy"],
          description:
            "Pipeline phase this claim is for (defaults to 'review' when omitted)",
          example: "patch",
        },
        prCreatedAt: {
          type: "string",
          description:
            "ISO timestamp of the GitHub PR's actual creation time. Only applied on first claim (record creation); ignored on subsequent claims since the field is immutable once set.",
          example: "2026-01-01T00:00:00.000Z",
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
          description:
            "Agent ID (admin tokens only; agent tokens use token identity)",
          example: "agent-id-123",
        },
        maxConcurrent: {
          type: "integer",
          description: "Maximum concurrent PRs to claim",
          example: 1,
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
      "Increment patchCycles and conditionally reset reviewState=pending",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          example: "clx0987654321",
        },
        commitSha: {
          type: "string",
          description:
            "Current head commit SHA. When provided and it differs from the record's stored commitSha, reviewState resets to pending and commitSha is updated. When it matches, reviewState is left untouched (no-op patch cycle). When omitted, reviewState unconditionally resets to pending (legacy behavior).",
          example: "abc123def456",
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
];

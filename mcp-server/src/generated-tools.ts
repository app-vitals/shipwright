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
          description:
            "Filter by repo (`org/repo` format). Repeatable — pass `?repo=` multiple times to match any repo in the list (e.g. `?repo=org/a&repo=org/b`). A single `?repo=` behaves identically to before (exact match).",
          example: "org/repo",
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
          description:
            "Filter by org — matches any repo whose `org/repo` string starts with `<org>/`. Repeatable — pass `?org=` multiple times to match any of several orgs. Combines with `repo` as an AND filter.",
          example: "org",
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
        hitl: {
          type: "string",
          enum: ["true", "false"],
          example: "true",
        },
        sort: {
          type: "string",
          enum: ["asc", "desc"],
          example: "asc",
        },
        updatedSince: {
          type: "string",
          description:
            "Only return tasks with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
          example: "2026-01-01T00:00:00.000Z",
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
      "hitl",
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
      },
      required: ["id"],
      additionalProperties: false,
    },
    method: "POST",
    pathTemplate: "/tasks/{id}/skip",
    queryParams: [],
    pathParams: ["id"],
    hasBody: false,
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
          description: "Max records to return",
          example: "50",
        },
        offset: {
          type: "string",
          description: "Pagination offset",
          example: "0",
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
          description:
            "Filter by repo. Repeatable (?repo=a&repo=b) to match any of several repos.",
          example: "org/repo",
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
          description:
            "Filter by org — matches repos whose 'org/repo' starts with '<org>/'. Repeatable (?org=a&org=b) to match any of several orgs. Composable with repo (AND).",
          example: "org",
        },
        prNumber: {
          type: "string",
          description: "PR number (parsed as integer)",
          example: "42",
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
        blocked: {
          type: "string",
          enum: ["true", "false"],
          description:
            "When true, return only PRs considered blocked: pr.blocked===true OR (linked task exists AND task.status==='blocked'). Task.hitl is not consulted — post-redesign, Type A tasks (the only ones that keep hitl:true) never have a linked PR. Composable with other filters (e.g. state=open).",
          example: "true",
        },
        sort: {
          type: "string",
          enum: ["asc", "desc"],
          description:
            "Order results by createdAt. Default is ascending (asc), preserving current behavior for existing callers. Unrelated to claim-next's own deterministic ordering.",
          example: "asc",
        },
        updatedSince: {
          type: "string",
          description:
            "Only return PRs with updatedAt >= this ISO timestamp. A conservative pre-filter, not a precise sync anchor.",
          example: "2026-01-01T00:00:00.000Z",
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
          description:
            "Current head commit SHA. When provided and it differs from the record's stored commitSha, reviewState resets to pending and commitSha is updated. When it matches, reviewState is left untouched (no-op patch cycle). When omitted, reviewState unconditionally resets to pending (legacy behavior).",
          example: "abc123def456",
        },
        ciFailureSignature: {
          type: "string",
          description:
            "Signature identifying the current CI failure (e.g. which check + which test). When it matches the record's stored lastCiFailureSignature, consecutiveCiFailureCount increments; when it differs (or none is stored), the count resets to 1 and the new signature is stored. Crossing CI_FAILURE_BLOCK_THRESHOLD (3) auto-sets blocked:true plus a descriptive blockedReason. When omitted (e.g. merge-conflict/review-fix patch calls unrelated to CI), both fields are left untouched.",
          example: "npm-test-failed-foo.unit.test.ts",
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
          description: "Identifier for the finding (e.g. file:line or a slug).",
          example: "src/foo.ts:42",
        },
        disposition: {
          type: "string",
          enum: ["resolved", "superseded", "rejected"],
          description:
            "Triage outcome. source:'patch' may only submit 'rejected' — server-enforced (400 otherwise); source:'review' may submit any value.",
          example: "resolved",
        },
        source: {
          type: "string",
          enum: ["review", "patch"],
          description: "Which pipeline phase is recording this finding.",
          example: "review",
        },
        evidence: {
          type: "string",
          example: "Fixed the null check in the follow-up commit.",
        },
        at: {
          type: "string",
          description:
            "ISO timestamp of when the finding was triaged. Defaults to the current time when omitted.",
          example: "2026-08-17T12:00:00.000Z",
        },
        agentId: {
          type: "string",
          description: "Agent instance that triaged this finding.",
          example: "agent-abc123",
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
          description: "Max records to return",
          example: "50",
        },
        offset: {
          type: "string",
          description: "Pagination offset",
          example: "0",
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
];

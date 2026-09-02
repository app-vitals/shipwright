# Plan: Unify agent provisioning

**Session:** `unify-agent-provisioning`
**Repo:** `app-vitals/shipwright`

## Problem

The admin app has two separate entry points for creating an agent, and they've
diverged in what they collect:

- **`+ New agent`** (`GET/POST /admin/agents/new`, `admin/src/admin-ui.ts:1169-1311`,
  rendered by `renderNewLocalAgentPage()` in `admin/src/admin-ui-pages.ts:601-735`) —
  collects name, type, runtime (in-cluster/self-hosted), repos, authorAllowlist,
  Claude OAuth token, and a `restrictSlackToMembers` checkbox. No Slack or GitHub
  App setup.
- **`Connect Slack app`** (`/admin/provision*`, `admin-ui.ts:2064-2400+`) — a
  multi-step wizard (Create Slack App → Install GitHub App → Bot Token →
  Complete) collecting Slack xoxp/xapp tokens, GitHub auth (PAT, or GitHub App
  via `admin/src/github-app-provisioning-client.ts`), and an Anthropic API key.
  No `authorAllowlist` or `restrictSlackToMembers`.

Both call `agentService.create()` directly from `admin-ui.ts` (not the external
`agents-api.ts` `POST /agents`, which has no Slack/GitHub awareness at all and is
unaffected by this work).

The deeper issue found during design: the wizard hardcodes Slack as a mandatory
first step before GitHub can be configured, and gates both behind a "new vs.
existing agent" picker. There's no way today to attach a GitHub App to an agent
that already has Slack connected (or vice versa) without re-running the whole
wizard.

**Bugs found mid-implementation.** While UAP-1.1/UAP-1.2 were underway, an
audit of the same code surface (prompted by a live agent missing its "Sync
Manifest" button) turned up two real gaps, split into their own follow-on
tasks (UAP-1.3, UAP-1.4) rather than folded into the in-flight extraction
tasks, so UAP-1.1/UAP-1.2 stay pure extractions with no behavior change:

- `agent.slackId` is never populated by the OAuth wizard (`exchangeOAuthCode`
  only returns a bot token; nothing calls Slack's `auth.test` to resolve and
  persist the bot's own user id). This silently hides the "Sync Manifest"
  button for every agent provisioned through the current flow.
- The GitHub App manifest exchange discards `clientId`/`clientSecret` instead
  of persisting them, and the GitHub App install step never calls
  `reconcileSystemCrons()` (unlike the Slack path's parity step).

## Design

1. **Decouple** Slack-connect and GitHub-connect into independently callable
   service functions keyed by agent id, each exposed via its own route
   (`/admin/agents/:id/connect-slack`, `/admin/agents/:id/connect-github`).
2. **Unify** the creation page: one `+ New agent` button, one page, with the
   existing core fields plus an Anthropic API key field (parity with the
   wizard) and optional "Connect Slack" / GitHub-auth toggles that chain into
   the new connect-* routes for the just-created agent.
3. **Add parity actions** to the agent detail page so Slack/GitHub can be
   connected later if skipped at creation time — shown only when not already
   configured, mirroring the existing "Sync Manifest" visibility pattern.
4. **Retire** `/admin/provision` and `/admin/provision/start` (the entry-point
   wizard), with a 302 redirect from the old URL for stale bookmarks/docs.
5. **Migrate callback URLs.** The OAuth/manifest callback routes
   (`/admin/provision/complete`, `/admin/provision/xapp-token`,
   `/admin/provision/github-app/complete`, `/admin/provision/github-app/installed`)
   are baked into the `redirect_uri`/`setup_url` of already-registered Slack
   Apps and GitHub Apps for existing agents. Rather than freezing them forever,
   the operator (Dan) will manually update those external app configs to the
   new `/admin/agents/:id/connect-*` paths, so the old namespace can be fully
   retired instead of living on as permanent aliases. Sequenced as
   add → migrate → remove so nothing breaks mid-flight: new routes ship first
   (old ones keep working as delegating aliases), the external configs get
   updated on the operator's own schedule (no urgency — old aliases still
   work), then the aliases are deleted last.

## Tasks

| Task | Title | Layer | Hours | Complexity/Model | HITL | Depends on |
|---|---|---|---|---|---|---|
| UAP-1.1 | Extract Slack provisioning into a service fn + new `/admin/agents/:id/connect-slack*` routes | API | 4 | 4 / sonnet | | — |
| UAP-1.2 | Extract GitHub App/PAT provisioning into a service fn + new `/admin/agents/:id/connect-github*` routes | API | 3 | 4 / sonnet | | — |
| UAP-1.3 | Resolve and persist `agent.slackId` after Slack OAuth completes (bug fix) | API | 2 | 3 / sonnet | | UAP-1.1 |
| UAP-1.4 | Persist GitHub App client id/secret + reconcile crons after install (bug fix) | API | 2 | 2 / sonnet | | UAP-1.2 |
| UAP-2.1 | Unified agent-creation page (core fields + Anthropic key + Slack/GitHub toggles) | Frontend | 5 | 4 / sonnet | | UAP-1.1, UAP-1.2 |
| UAP-2.2 | Single "+ New agent" CTA on the agents list page | Frontend | 1 | 2 / haiku | | UAP-2.1 |
| UAP-2.3 | Agent detail page: connect-later actions for Slack/GitHub | Frontend/API | 3 | 3 / sonnet | | UAP-1.1, UAP-1.2 |
| UAP-3.1 | Retire `/admin/provision` + `/admin/provision/start` entry pages, add redirect | API | 3 | 3 / sonnet | | UAP-2.1, UAP-2.2, UAP-2.3 |
| UAP-3.2 | Migrate external Slack/GitHub App callback URLs for existing agents | Shared | 1 | 1 / haiku | ⚠ HITL | UAP-1.1, UAP-1.2 |
| UAP-3.3 | Remove deprecated `/admin/provision` callback alias routes | API | 1 | 2 / haiku | | UAP-3.2 |
| UAP-4.1 | Update quickstart/deploy-kubernetes docs for the unified flow | Shared | 1 | 1 / haiku | | UAP-3.1 |

### Dependency graph

```
[START]
  ├─ UAP-1.1 ─┬─→ UAP-1.3
  └─ UAP-1.2 ─┴─→ UAP-1.4
  UAP-1.1 ─┐
  UAP-1.2 ─┴─→ UAP-2.1 ─→ UAP-2.2 ─┐
           │                        ├─→ UAP-3.1 ─→ UAP-4.1
           └──→ UAP-2.3 ────────────┘
  UAP-1.1, UAP-1.2 ──→ UAP-3.2 ⚠HITL ──→ UAP-3.3
```

UAP-1.3 and UAP-1.4 are independent bug-fix follow-ons — nothing in UAP-2.x/3.x
depends on them, since the unification work doesn't require either fix to
function correctly.

### Breaking-change safety

Every task is safe to deploy standalone once its listed dependencies are
merged. UAP-3.1 and UAP-3.3 are the "remove" steps of two independent
add → migrate → remove sequences (entry-point pages, and callback aliases,
respectively) and must not land ahead of their dependencies.

### HITL scan

`UAP-3.2` — updating a third-party app's registered redirect/callback URL is a
web-UI action with no code diff; flagged by keyword match ("GitHub settings")
and judgment (human action in an external provider's console). No other task
in this plan requires human steps.

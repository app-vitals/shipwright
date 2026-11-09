# Learn vs. Memory: How They Should Converge

Status: recommendation for Dan to decide (task APP-6.1). Read-only comparison; no code moves.

Two systems both answer "how does an agent get better between sessions?" but they store different things in different places for different readers.

- **learn**: shipwright's `/learn` command, the `learning-capture` skill and the `/learn-dream` batch job.
- **memory**: the specialists repo's `memory` plugin and `services/memory` service (`app-vitals/specialists`).

## What each stores

| | learn | memory |
|---|---|---|
| Unit | One concise rule or a skill, edited into a context file | A `MEMORY.md` entry (text, up to 3 trigger phrases, importance 1-10), daily notes, ingested transcripts |
| Where | Files in git: `CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`, skills, plugin repos, `workspace/LEARNINGS.md` ([routing table](../plugins/shipwright/skills/learning-capture/SKILL.md)) | Postgres + pgvector behind an HTTP service, one private store per agent ([schema](https://github.com/app-vitals/specialists/blob/main/services/memory/prisma/schema.prisma): `Document`, `Chunk`, `MemoryEntry`, `Recall`, `DreamRun`) |
| Who writes | Interactive: the model edits the file in-turn after the [generalization gate](../plugins/shipwright/skills/learning-capture/references/generalization-gate.md). Batch: the `learning-dreamer` agent ([agent](../plugins/shipwright/agents/learning-dreamer.md)), default `--review` writing `LEARNINGS-REVIEW.md` | Agent via `memory_write`; hooks ingest transcripts at Stop; nightly `/memory:dream` where the agent returns add/merge/supersede operations and the service validates and applies them ([dream.md](https://github.com/app-vitals/specialists/blob/main/plugins/memory/commands/dream.md), [docs/memory.md](https://github.com/app-vitals/specialists/blob/main/docs/memory.md)) |
| Who reads | Every session in that repo/user scope, because Claude Code loads the files into the prompt. No query step | Only the owning agent: SessionStart injects `MEMORY.md` (about 2,000 tokens) plus today's and yesterday's notes; everything else via `memory_search` / `memory_get` |
| Recall | Always-on, whole file | Hybrid vector + keyword search, reciprocal-rank fusion, recency decay, importance weighting, MMR |
| Audit trail | Git history and PR review | `DREAMS.md` diary, `DreamRun` counts, `MemoryEntry.supersededBy` chain |
| Quality gate | Generalization test; dream additionally requires recurrence across sessions | Promotion needs score >= 0.35, >= 2 recalls, >= 2 unique queries; service rejects sourceless ops, >25% entry loss, or over-budget sets |
| Isolation | Scope = file location (package, project, user, plugin) | Per agent, enforced by `agent_id` filters plus Postgres row-level security |
| Scheduling | `learn-dream` cron, default 03:00, disabled by default ([coding-specialty-defaults.ts](../admin/src/coding/coding-specialty-defaults.ts)), gated by [check-learn-dream.ts](../plugins/shipwright/scripts/check-learn-dream.ts) | Nightly dream per specialist agent |

## Overlap

- Both have a "dream": batch consolidation between sessions that adds, merges and prunes, gated by recurrence/frequency rather than a single occurrence.
- Both use the same two ideas: promote only what recurs, and keep the always-loaded layer small (one line per concept in `CLAUDE.md`; roughly 2,000 tokens for `MEMORY.md`).
- Both mine session transcripts (learn-dream reads `~/.claude/projects/**/*.jsonl`; memory ingests them via the Stop hook).
- Both have a "facts about a person or agent" notion: learn's Person/agent routing row, memory's entries.

## Gaps

What learn has that memory lacks:

- **Output is reviewable code.** Learnings land in a diff, can be reviewed in a PR, and travel with the repo to every clone, human or agent. Memory content is invisible to humans unless they query the service.
- **Team/shared scope.** `CLAUDE.md` is shared across everyone on the repo. Memory is deliberately per-agent private.
- **Cross-repo routing** of harness improvements (Harness TODO queue flushed into one PR per tool).
- **No infrastructure**: works with a bare checkout, no Postgres, embedding service or API keys.

What memory has that learn lacks:

- **Episodic recall.** Dated notes, "what did we decide on Tuesday", transcripts searchable on demand. learn deliberately refuses one-off facts (the gate rejects them).
- **Scale without prompt cost.** Search means memory can grow without growing every prompt; `CLAUDE.md` cannot.
- **Provenance and safety rails**: required `Source: path#Lx-Ly`, untrusted-provenance filtering, entry-loss cap, locks, supersession chain.
- **Per-agent identity** for fleets of long-lived specialists with their own voice and history.
- **Graceful degradation** (FTS-only when embeddings are down; hooks never block a session).

Note the two are disjoint on the key axis: learn captures *durable, general, repo-visible rules*; memory captures *agent-private, possibly one-off, retrievable experience*. The gate that makes learn good (reject anything non-general) is exactly what memory must not apply.

## Options

1. **Memory subsumes learn.** Everything becomes a memory entry; `/learn` becomes `memory_write`.
2. **Keep separate with clear roles, plus a thin one-way bridge.**
3. **Move learn to agent-platform unchanged.**

### 1. Memory subsumes learn

- Pros: one dream pipeline, one gate, one store; stronger provenance; solves prompt bloat.
- Cons: loses the git audit trail and team sharing (rules would no longer be in `CLAUDE.md`, so interactive human sessions and non-specialist agents stop seeing them); requires the memory service for every repo, including self-hosted shipwright users (the MIT self-host story gets a Postgres/pgvector/embedding dependency); changes the learn gate semantics; coding agents use Claude Code's native `CLAUDE.md` loading, which memory would have to replace with hooks.

### 2. Keep separate, clear roles (recommended)

- learn owns **rules and procedures**: things a teammate should also follow. Lives in git, reviewed in PRs.
- memory owns **experience**: who, what happened, what was decided. Lives in the service, private per agent.
- Bridge (later, optional): the memory dream may *propose* a candidate to learn when an entry is general, recurring and not agent-specific, emitted as a `LEARNINGS-REVIEW.md` item. Never an automatic `CLAUDE.md` write. This reuses learn-dream's existing review mode and its gate.
- Pros: no migration; keeps shipwright self-hostable without the memory stack; each system keeps the property it is good at; the bridge gives one-way promotion from episodic to durable.
- Cons: two dream jobs and two vocabularies to explain; the Person/agent routing row overlaps with memory entries and needs a rule ("about a person the agent works with and agent-private -> memory; standing rule -> learn"); duplicate capture is possible until the bridge exists.

### 3. Move learn to agent-platform unchanged

- Pros: smallest change; learn sits next to the other platform plugins.
- Cons: learn is useful to any Claude Code user of the shipwright plugin, so moving it forces a platform dependency for no gain; it does not address the overlap at all, only relocates it. Reasonable only if shipwright is being slimmed to pipeline-only commands for unrelated reasons.

## Recommendation

**Option 2: keep learn and memory separate with explicit roles, and add a one-way "propose to learn" bridge from the memory dream later.**

Roles: learn = shared, general, reviewable rules in git. memory = private, retrievable experience in the service. The deciding factor is that the two systems apply opposite filters (learn rejects the one-off; memory exists to keep it), so merging them forces one to give up its core property.

Tradeoffs accepted: two systems to document and run, and a small ongoing routing judgement at the Person/agent boundary. Revisit option 1 only if shipwright drops the self-host path and every agent is a specialist with the memory service available.

Suggested follow-ups if accepted (not done here): document the role split in `learning-capture`'s routing table; add the "propose to learn" step to the memory dream; leave all code where it is.

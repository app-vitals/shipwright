# Learnings: dev-task prompt trial (DTA-9.4)

Tool: `bun scripts/prompt-trial-tally.ts --command dev-task` (see
`scripts/prompt-trial-tally.ts`). It reads Claude Code session transcripts and
compares `/shipwright:dev-task` against `/shipwright:dev-task-lean`.

## Baseline

Reference-file load rate, `dev-task-lean` (% of runs that loaded the file):

| Reference | Load rate |
|---|---|
| push-and-ci | 27% |
| pre-ship | 24% |
| handoff | 21% |
| implementation-dispatch | 14% |
| worktree-recovery | 4% |
| task-lifecycle | 2% |

Cost per run (estimated): $0.90 default (`dev-task`) vs $1.16 lean
(`dev-task-lean`). These figures predate the per-`message.id` dedupe in the
tally script (one API response was counted once per content block), so they
overstate cost and turns; re-run the tally to refresh them.

## Caveats

- Single agent: one agent's transcripts, so no between-agent variance.
- Reference reads are confounded: a read may be by the main thread or by a
  subagent, and the tally attributes it to the run either way.
- A low load rate may mean the step was not needed in that run, not that it was
  skipped. Load rate alone is not adherence.
- Cost is estimated from token usage with the price table in the script
  (`PRICE_PER_MTOK`), not from billing. A numeric `costUSD` on a transcript line
  overrides it.

## CI first-pass re-check

To be redone after the switch to the lean prompt, using the DTA-8.2 metrics when
available. Do not conclude anything about CI first-pass rate from this baseline.

Run the tally over the post-switch transcripts:

```bash
bun scripts/prompt-trial-tally.ts --command dev-task \
  --dir ~/.claude/projects/<agent-project-dir> [--json]
```

Compare, lean vs default:

- `push-and-ci` load rate against the 27% baseline (and whether it rises when
  CI failed first time).
- CI first-pass rate (DTA-8.2 metric) for lean runs vs the pre-switch default
  runs.
- Patch cycles per PR, and mean cost / turns per run (main vs subagent).

## Learnings template for later prompts

Copy per prompt trial.

```markdown
### <prompt name>

- Prompt: <file / skill, versions compared>
- Hypothesis: <what should change and why>
- Arms: <variant A vs variant B, how assigned>
- n: <runs per arm>
- Stop condition: <n reached, date, or a regression threshold>
- Reference load rates: <per file, per arm>
- Cost / turns: <mean and median, main vs subagent, per arm>
- Adherence: <did required steps happen; evidence beyond load rate>
- CI first-pass: <rate per arm>
- Patch cycles: <mean per PR per arm>
- Decision: <adopt / revert / extend trial>
- Caveats: <confounds, estimated cost, sample limits>
```

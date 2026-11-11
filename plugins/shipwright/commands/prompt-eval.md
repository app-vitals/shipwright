---
name: prompt-eval
description: "Run the calibration-gated prompt-audit eval tier for one finding and print a PR-citable result block. Refuses any quality result without a signed passing record in docs/prompt-audit-calibration.md (cost-only output on a failed record). Refuses without --max-cost-usd. Never runs from the cron. Flags: --finding <fp>, --kind with-without|ab|trigger|production-series, --max-cost-usd <n> (default 5), --model <id>, --runs <n> (default 3)."
---

Invoke the `prompt-eval` skill.

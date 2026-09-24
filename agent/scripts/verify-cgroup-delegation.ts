/**
 * agent/scripts/verify-cgroup-delegation.ts
 * CI-only report: prints which process-tree-kill mode the built agent image
 * actually resolves to under the pod's restricted securityContext.
 *
 * A green `bun test` run in CI's normal (unrestricted) process says nothing
 * about whether /sys/fs/cgroup is delegated and writable inside the deployed
 * container — only running the built image with matching restrictions does.
 * The `agent-docker-build` CI job invokes this script via:
 *
 *   docker run --rm --user 1000 --security-opt=no-new-privileges \
 *     --entrypoint bun shipwright-agent:ci \
 *     run agent/scripts/verify-cgroup-delegation.ts
 *
 * Unlike verify-browser-launch.ts, this is NOT a pass/fail gate: a container
 * without cgroup delegation is an expected, fully-handled configuration —
 * agent/src/process-tree-kill.ts falls back to a procfs descendant walk. The
 * script exits 0 either way and only exits non-zero if the probe itself
 * crashes unexpectedly. Its value is the durable, per-build log line showing
 * which mode production is really running in.
 *
 * Deliberately calls the SAME probe the production path calls, rather than
 * reimplementing the check — a reimplementation could drift and report a
 * mode the agent never actually uses.
 */
import {
  CGROUP_MOUNT_ROOT,
  probeCgroupDelegation,
  resolveCgroupBase,
} from "../src/process-tree-kill.ts";

try {
  const base = resolveCgroupBase();
  const support = probeCgroupDelegation();
  console.log(`cgroup mount root: ${CGROUP_MOUNT_ROOT}`);
  console.log(`resolved cgroup base: ${base ?? "(none)"}`);
  console.log(`probe: ${support.reason}`);
  console.log(
    support.usable
      ? "Process-tree kill mode: CGROUP (cgroup.kill, atomic)"
      : "Process-tree kill mode: PROCFS FALLBACK (/proc/<pid>/task/*/children walk)",
  );
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`Error: cgroup delegation probe crashed — ${msg}`);
  process.exit(1);
}
process.exit(0);

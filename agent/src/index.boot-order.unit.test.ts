import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// index.ts is a top-level boot script (importing it would boot an agent), so
// the boot sequence is asserted structurally against its source text.
const source = await Bun.file(join(import.meta.dir, "index.ts")).text();

function position(marker: string): number {
  const at = source.indexOf(marker);
  expect(at, `boot marker missing from index.ts: ${marker}`).toBeGreaterThan(
    -1,
  );
  return at;
}

describe("index.ts boot sequence", () => {
  it("keeps the documented boot order", () => {
    const order = [
      "ensureAgentHome(config.paths.home)",
      "startHealthServer(",
      "await runMiseStartup(",
      "await installPlugins();",
      "new HttpShipwrightRuntimeClient(",
      "await syncConfig();",
      "runtimeClient.reconcileSystemCrons(agentId)",
      "setInterval(() => void runPeriodicTick()",
      "void syncCrons();",
      'if (await startSlackIfPossible(slackStartDeps)) {\n  console.log("[agent] Slack app started',
    ];
    const positions = order.map(position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("calls the extension's cron-jobs hook via planCronSchedule, not classification directly", () => {
    expect(source).toContain("planCronSchedule(extension, jobs)");
  });
});

describe("index.ts composition root", () => {
  it("imports no coding modules other than the single coding extension", () => {
    const codingImport =
      /from "\.\/(check-|loop-|pr-|claim-invariant|work-|allow-self-review|review-author|patch-author|cleanup-merged)[^"]*"/;
    expect(source).not.toMatch(codingImport);
    expect(source).toContain('from "./coding/extension.ts"');
  });
});

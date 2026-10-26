import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// boot.ts holds the boot sequence and index.ts is the thin entry that runs it
// (importing either would boot an agent), so both are asserted structurally
// against their source text.
// boot.ts ships in the @app-vitals/agent-runtime package (AGR-4.4), so it is
// read from the installed copy.
const source = await Bun.file(
  join(
    import.meta.dir,
    "..",
    "..",
    "node_modules",
    "@app-vitals",
    "agent-runtime",
    "boot.ts",
  ),
).text();
const entrySource = await Bun.file(join(import.meta.dir, "index.ts")).text();

function position(marker: string): number {
  const at = source.indexOf(marker);
  expect(at, `boot marker missing from boot.ts: ${marker}`).toBeGreaterThan(-1);
  return at;
}

describe("boot.ts boot sequence", () => {
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
      'if (await startSlackIfPossible(slackStartDeps)) {\n    console.log("[agent] Slack app started',
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
    expect(entrySource).not.toMatch(codingImport);
    expect(entrySource).toContain('from "./coding/extension.ts"');
  });

  it("keeps the runtime boot free of any coding extension import", () => {
    expect(source).not.toContain("coding/");
  });

  it("is a thin entry: one startAgent call with the coding extension", () => {
    expect(entrySource).toContain("await startAgent([createCodingExtension]);");
    expect(entrySource).not.toContain("ensureAgentHome");
    expect(entrySource.split("\n").length).toBeLessThan(25);
  });

  it("exports startAgent from boot.ts", () => {
    expect(source).toContain("export async function startAgent(");
  });
});

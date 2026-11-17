/**
 * task-store/src/plan-reconciler-fixtures.ts
 *
 * Test helper: a fetch function that replays recorded GitHub responses from
 * fixtures/plan-reconciler-github.json. Unrecorded requests fail loudly.
 */

import fixtures from "./fixtures/plan-reconciler-github.json" with {
  type: "json",
};

type Recording = { status?: number; body: unknown };

export function fixtureFetch(): typeof fetch {
  const table = fixtures as unknown as Record<string, Recording>;
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    const rec = table[key];
    if (!rec || key.startsWith("_")) {
      throw new Error(`no recorded GitHub fixture for ${key}`);
    }
    return new Response(JSON.stringify(rec.body), {
      status: rec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

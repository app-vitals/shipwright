import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { adminSessionCookie, loadTargets, poll, uniqueName } from "./client.ts";

/**
 * Deployment check: kubectl through the preview kube context, because the
 * admin API reports no workload state (it returns only the deployment name
 * from POST /agents/{id}/provision). Context comes from PREVIEW_KUBE_CONTEXT,
 * default "kind-preview" (the context the preview action fixes). Without a
 * kubectl binary the Deployment checks fall back to the admin API: provision
 * is idempotent and returns the name of the Deployment it reconciled, and
 * delete reports the k8s teardown step as completed.
 *
 * Pod state follows probe finding P3: an in-cluster agent only reaches Running
 * about 2.5 minutes after creation, far over the 60 s suite budget, so this
 * asserts the Deployment exists and is scheduled (spec.replicas >= 1), never
 * that a pod is Ready.
 */

const t = loadTargets();
const kubeContext = process.env.PREVIEW_KUBE_CONTEXT ?? "kind-preview";
const useKubectl = Bun.which("kubectl") !== null;

let cookie = "";
let agentId: string | undefined;
let deploymentName = "";

function adminHeaders(): Record<string, string> {
  return { Cookie: cookie, "Content-Type": "application/json" };
}

async function findDeployment(
  name: string,
): Promise<{ spec: { replicas?: number } } | undefined> {
  const proc = Bun.spawn(
    [
      "kubectl",
      "--context",
      kubeContext,
      "get",
      "deployments",
      "--all-namespaces",
      "--field-selector",
      `metadata.name=${name}`,
      "-o",
      "json",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `kubectl get deployments failed (context ${kubeContext}): ${await new Response(proc.stderr).text()}`,
    );
  }
  const items = (
    JSON.parse(out) as { items: { spec: { replicas?: number } }[] }
  ).items;
  return items[0];
}

async function deleteAgent(id: string): Promise<Response> {
  return fetch(`${t.adminUrl}/agents/${id}`, {
    method: "DELETE",
    headers: adminHeaders(),
    body: "{}",
  });
}

beforeAll(async () => {
  cookie = await adminSessionCookie(t.adminUrl);
});

afterAll(async () => {
  if (agentId) await deleteAgent(agentId).catch(() => undefined);
});

describe("agent provisioning canary", () => {
  it("creates an in-cluster agent and its Deployment appears", async () => {
    const res = await fetch(`${t.adminUrl}/agents`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: uniqueName("canary-agent"),
        specialty: "coding",
        runtime: "in-cluster",
      }),
    });
    expect(res.status).toBe(200);
    agentId = ((await res.json()) as { id: string }).id;

    const provision = await fetch(`${t.adminUrl}/agents/${agentId}/provision`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(provision.status).toBe(200);
    deploymentName = ((await provision.json()) as { deploymentName: string })
      .deploymentName;
    expect(deploymentName).toBeTruthy();

    if (!useKubectl) return;
    const deployment = await poll(() => findDeployment(deploymentName), 20_000);
    expect(deployment).toBeDefined();
    expect(deployment?.spec.replicas ?? 0).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("deletes the agent and the Deployment is gone", async () => {
    expect(agentId).toBeDefined();
    const res = await deleteAgent(agentId as string);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentDeleted: boolean;
      completed: string[];
    };
    expect(body.agentDeleted).toBe(true);
    agentId = undefined;

    if (!useKubectl) {
      expect(body.completed).toContain("k8s");
      return;
    }
    const gone = await poll(
      async () => ((await findDeployment(deploymentName)) ? undefined : true),
      20_000,
    );
    expect(gone).toBe(true);
  }, 40_000);
});

/**
 * admin/src/anthropic-identity-fixture-spec.integration.test.ts
 * Offline contract test: every request and response in the Anthropic recorded
 * fixture doubles must satisfy the Anthropic OpenAPI 3.1 spec copied into the
 * repo (pinned to the @anthropic-ai/sdk version in admin/package.json). A
 * recorded fixture that drifts from the spec fails here.
 *
 * Known gap: POST /v1/oauth/token is not in the spec, so the token exchange is
 * not covered by this test (see anthropic-identity-client.fixtures.ts).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type AnthropicRecordedFixtures,
  loadRecordedFixtures,
} from "./anthropic-identity-client.fixtures.ts";
import {
  loadSpec,
  readSpecSdkVersion,
  validateRecordedFixturesAgainstSpec,
} from "./anthropic-openapi-contract.fixtures.ts";

const spec = loadSpec();

function clone(): AnthropicRecordedFixtures {
  return structuredClone(loadRecordedFixtures());
}

describe("pinned Anthropic OpenAPI spec", () => {
  it("is OpenAPI 3.1", () => {
    expect(spec.openapi).toStartWith("3.1");
  });

  it("is pinned to exactly the @anthropic-ai/sdk version in admin/package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    const declared: string = pkg.dependencies["@anthropic-ai/sdk"];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect(readSpecSdkVersion()).toBe(declared);
  });
});

describe("Anthropic identity recorded fixtures vs spec", () => {
  it("every recorded request and response conforms to the spec", () => {
    const { problems } = validateRecordedFixturesAgainstSpec(
      loadRecordedFixtures(),
      spec,
    );
    expect(problems).toEqual([]);
  });

  it("covers every operation the client uses", () => {
    const { operations } = validateRecordedFixturesAgainstSpec(
      loadRecordedFixtures(),
      spec,
    );
    const used = new Set(operations.map((o) => `${o.method} ${o.template}`));
    for (const op of [
      "POST /v1/organizations/service_accounts",
      "GET /v1/organizations/service_accounts",
      "POST /v1/organizations/service_accounts/{service_account_id}/archive",
      "POST /v1/organizations/service_accounts/{service_account_id}/workspaces",
      "POST /v1/organizations/federation_rules",
      "GET /v1/organizations/federation_rules",
      "POST /v1/organizations/federation_rules/{federation_rule_id}/archive",
    ]) {
      expect(used).toContain(op);
    }
  });

  describe("fails when a recorded fixture drifts from the spec", () => {
    const first = (c: AnthropicRecordedFixtures, scenario: string) =>
      c.scenarios[scenario][0];

    it("response is missing a required field", () => {
      const c = clone();
      // biome-ignore lint/suspicious/noExplicitAny: mutate recorded JSON
      delete (first(c, "createServiceAccount_success").response.body as any).id;
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/required property 'id'/);
    });

    it("response has a wrong type", () => {
      const c = clone();
      // biome-ignore lint/suspicious/noExplicitAny: mutate recorded JSON
      (first(c, "createServiceAccount_success").response.body as any).name = 7;
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.length,
      ).toBeGreaterThan(0);
    });

    it("request carries a property the spec does not allow", () => {
      const c = clone();
      // biome-ignore lint/suspicious/noExplicitAny: mutate recorded JSON
      (first(c, "createServiceAccount_success").request.body as any).bogus = 1;
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/additional properties/);
    });

    it("request is missing a required property", () => {
      const c = clone();
      // biome-ignore lint/suspicious/noExplicitAny: mutate recorded JSON
      delete (first(c, "createServiceAccount_success").request.body as any)
        .name;
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/required property 'name'/);
    });

    it("path is not in the spec", () => {
      const c = clone();
      first(c, "createServiceAccount_success").request.path =
        "/v1/organizations/service_accountz";
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/path is not in the spec/);
    });

    it("method is not defined for the path", () => {
      const c = clone();
      first(c, "createServiceAccount_success").request.method = "DELETE";
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/method not defined/);
    });

    it("query parameter is unknown", () => {
      const c = clone();
      first(c, "findServiceAccountByName_empty").request.query = {
        limitt: "1",
      };
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/query parameter "limitt"/);
    });

    it("query value violates the parameter schema", () => {
      const c = clone();
      first(c, "findServiceAccountByName_empty").request.query = {
        limit: "1000",
      };
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/query "limit"/);
    });

    it("status code is not documented", () => {
      const c = clone();
      first(c, "createServiceAccount_success").response.status = 418;
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.join("\n"),
      ).toMatch(/status 418 is not documented/);
    });

    it("error body does not match ErrorResponse", () => {
      const c = clone();
      first(c, "createServiceAccount_duplicate_409").response.body = {
        message: "nope",
      };
      expect(
        validateRecordedFixturesAgainstSpec(c, spec).problems.length,
      ).toBeGreaterThan(0);
    });
  });
});

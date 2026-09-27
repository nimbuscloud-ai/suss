/**
 * A `from` on a results line, against the Rails orders action that
 * scopes its query to the tenant the gateway puts in a header. The same
 * three cases as the Express route: the header is quiet, `params` is a
 * finding, and a helper the walk stops in leaves the claim unchecked.
 */

import { afterAll, describe, expect, it } from "vitest";

import { tenantProject } from "./__fixtures__/tenantSource.js";

const project = tenantProject({
  fixture: "fixtures/rails-tenant",
  route: "app/controllers/orders_controller.rb",
  language: "ruby",
  packs: [
    { name: "rails", config: "suss.rails.json" },
    { name: "activerecord", config: "suss.activerecord.json" },
  ],
});
const tenantFrom = (written: string) =>
  project.rewrite(
    'tenant_id: request.headers["X-Tenant-Id"]',
    `tenant_id: ${written}`,
  );

afterAll(() => {
  project.remove();
});

describe("a Rails results line that says where the tenant comes from", () => {
  it("is quiet while the query takes the tenant from the header", async () => {
    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("reports the query once it takes the tenant from params", async () => {
    tenantFrom("params[:tenant_id]");

    const intent = await project.checkIntent();

    expect(intent.findings).toHaveLength(1);
    expect(intent.findings[0]).toMatchObject({
      kind: "valueFromElsewhere",
      boundary: "GET /orders",
      intent: { name: "orders-list", outcomeId: "listed" },
    });
    expect(intent.findings[0].message).toContain(
      "with tenant_id taken from input.headers.x-tenant-id; index takes it from input.params.tenant_id",
    );
  }, 60_000);

  it("reads through to_i to the header it converts", async () => {
    tenantFrom('request.headers["X-Tenant-Id"].to_i');

    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("leaves the claim unchecked when the walk stops inside a helper", async () => {
    tenantFrom('tenant_from(request.headers["Authorization"])');

    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toMatchObject([
      { intent: "orders-list", reason: "unreadValue", outcomeId: "listed" },
    ]);
  }, 60_000);
});

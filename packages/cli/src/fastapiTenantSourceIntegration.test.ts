/**
 * A `from` on a results line, against the FastAPI orders search that
 * scopes its query to the tenant the gateway puts in a header. The same
 * three cases as the Express route: the header is quiet, the body is a
 * finding, and a helper the walk stops in leaves the claim unchecked.
 */

import { afterAll, describe, expect, it } from "vitest";

import { tenantProject } from "./__fixtures__/tenantSource.js";

const project = tenantProject({
  fixture: "fixtures/fastapi-tenant",
  route: "app/orders.py",
  language: "python",
  packs: [
    { name: "fastapi" },
    { name: "sqlalchemy", config: "suss.sqlalchemy.json" },
  ],
});
const tenantFrom = (written: string) =>
  project.rewrite(
    "Order.tenant_id == x_tenant_id",
    `Order.tenant_id == ${written}`,
  );

afterAll(() => {
  project.remove();
});

describe("a FastAPI results line that says where the tenant comes from", () => {
  it("is quiet while the query takes the tenant from the header", async () => {
    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("reports the query once it takes the tenant from the body", async () => {
    tenantFrom("filters.tenant_id");

    const intent = await project.checkIntent();

    expect(intent.findings).toHaveLength(1);
    expect(intent.findings[0]).toMatchObject({
      kind: "valueFromElsewhere",
      boundary: "POST /orders/search",
      intent: { name: "orders-search", outcomeId: "found" },
    });
    expect(intent.findings[0].message).toContain(
      "with tenant_id taken from input.headers.x-tenant-id; search_orders takes it from input.body.tenant_id",
    );
  }, 60_000);

  it("reads through int() to the header it converts", async () => {
    tenantFrom("str(int(x_tenant_id))");

    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("leaves the claim unchecked when the walk stops inside a helper", async () => {
    tenantFrom("decode_tenant(authorization)");

    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toMatchObject([
      { intent: "orders-search", reason: "unreadValue", outcomeId: "found" },
    ]);
  }, 60_000);
});

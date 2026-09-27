/**
 * A `from` on a results line, against the Express orders route that
 * scopes its query to the tenant in the caller's token.
 *
 * The route passes the token's tenant to the query, and the check is
 * quiet. A change that takes the tenant from the request body instead
 * is what the document exists to catch, and the check says which source
 * it found. A route that decodes the token with a function the run
 * cannot see gives the walk nothing to follow, so the claim goes
 * unchecked rather than wrong.
 */

import { afterAll, describe, expect, it } from "vitest";

import { tenantProject } from "./__fixtures__/tenantSource.js";

const project = tenantProject({
  fixture: "fixtures/express-tenant",
  route: "ordersList.ts",
  packs: [{ name: "express" }, { name: "pg" }],
});
const tenantFrom = (written: string) =>
  project.rewrite("[req.auth.tenantId]", `[${written}]`);

afterAll(() => {
  project.remove();
});

describe("a results line that says where the tenant comes from", () => {
  it("is quiet while the query takes the tenant from the token", async () => {
    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("reports the query once it takes the tenant from the body", async () => {
    tenantFrom("req.body.tenantId");

    const intent = await project.checkIntent();

    expect(intent.findings).toHaveLength(1);
    expect(intent.findings[0]).toMatchObject({
      kind: "valueFromElsewhere",
      severity: "error",
      boundary: "GET /orders",
      intent: { name: "orders-list", outcomeId: "listed" },
    });
    expect(intent.findings[0].message).toContain(
      'Intent "orders-list" says listed reads postgresql:orders with tenant_id taken from input.auth.tenantId; get takes it from input.body.tenantId',
    );
  }, 60_000);

  it("reads through a conversion to the input it converts", async () => {
    tenantFrom("String(req.auth.tenantId)");

    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([]);
  }, 60_000);

  it("leaves the claim unchecked when the walk stops at a call it cannot follow", async () => {
    tenantFrom("decodeTenant(req.headers.authorization)");

    const intent = await project.checkIntent();

    expect(intent.findings).toEqual([]);
    expect(intent.unchecked).toEqual([
      {
        intent: "orders-list",
        reason: "unreadValue",
        outcomeId: "listed",
        detail:
          "listed reads postgresql:orders with tenant_id taken from input.auth.tenantId: the walk from tenant_id stopped at `decodeTenant(req.headers.authorization)`, which it cannot follow.",
      },
    ]);
  }, 60_000);
});

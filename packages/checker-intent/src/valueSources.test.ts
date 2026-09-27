import { describe, expect, it } from "vitest";

import {
  type BehavioralSummary,
  type BoundaryBinding,
  functionCallBinding,
  type ProvenanceEntry,
  restBinding,
  storageBinding,
  type ValueRef,
} from "@suss/behavioral-ir";

import { checkIntentAgreement } from "./index.js";

import type { IntentEffect, IntentSummary } from "@suss/intent-ir";

const ordersTable = storageBinding({
  recognition: "pg",
  storageSystem: "postgresql",
  scope: "default",
  container: "orders",
});

/** Where an Express handler reads each part of the request. */
const EXPRESS_SPELLING = {
  headers: { path: ["request", "headers"], saysWhichField: true },
  query: { path: ["request", "query"], saysWhichField: true },
  params: { path: ["request", "params"], saysWhichField: true },
  body: { path: ["request", "body"], saysWhichField: true },
};

const restIntent = restBinding({
  transport: "http",
  method: "GET",
  path: "/orders",
  recognition: "intent",
});
const restCode = restBinding({
  transport: "http",
  method: "GET",
  path: "/orders",
  recognition: "express",
});
const fnIntent = functionCallBinding({
  transport: "in-process",
  recognition: "intent",
  package: "@acme/orders",
  exportPath: ["listOrders"],
});
const fnCode = functionCallBinding({
  transport: "in-process",
  recognition: "python",
  package: "@acme/orders",
  exportPath: ["listOrders"],
});

/** `reads postgresql:orders by tenant_id`, taking the tenant from `source`. */
function readsOrdersBy(source: string[]): IntentEffect {
  return {
    does: "reads",
    names: "postgresql:orders",
    fields: [],
    by: ["tenant_id"],
    from: [{ column: "tenant_id", path: source }],
  };
}

function intentOver(
  boundary: BoundaryBinding,
  effect: IntentEffect,
): IntentSummary {
  return {
    kind: "boundary",
    name: "orders-list",
    purpose: "List a tenant's orders.",
    audience: "web-client",
    source: "author",
    boundary,
    receives: [],
    outcomes: [
      {
        id: "listed",
        when: "",
        conditions: [],
        kind: "return",
        status: null,
        body: null,
        errorType: null,
        effects: [effect],
      },
    ],
    always: [],
  };
}

/** A unit that reads `orders` by `tenant_id`, with the tenant from `from`. */
function readingOrders(
  boundary: BoundaryBinding,
  from: ValueRef[] | null,
  inputs: BehavioralSummary["inputs"],
): BehavioralSummary {
  const provenance: ProvenanceEntry[] =
    from === null
      ? []
      : [{ at: { slot: "selector", effect: 0, name: "tenant_id" }, from }];
  return {
    kind: "handler",
    location: {
      file: "src/orders.ts",
      range: { start: 1, end: 20 },
      exportName: "listOrders",
    },
    identity: {
      name: "listOrders",
      exportPath: null,
      boundaryBinding: boundary,
    },
    inputs,
    transitions: [
      {
        id: "t0",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: ordersTable,
            callee: "pool.query",
            interaction: {
              class: "storage-access",
              kind: "read",
              fields: ["id"],
              selector: ["tenant_id"],
            },
          },
        ],
        location: { start: 12, end: 18 },
        isDefault: true,
        ...(provenance.length === 0 ? {} : { provenance }),
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...(boundary.semantics.name === "rest"
      ? { metadata: { requestSpelling: EXPRESS_SPELLING } }
      : {}),
  };
}

const TENANT_PARAMETER: BehavioralSummary["inputs"] = [
  { type: "parameter", name: "tenant", position: 0, role: null, shape: null },
];
const REQUEST_PARAMETER: BehavioralSummary["inputs"] = [
  { type: "parameter", name: "req", position: 0, role: "request", shape: null },
];

describe("a results line that says where a column's value comes from", () => {
  it("is quiet when the code takes the column from that source", () => {
    const result = checkIntentAgreement(
      [intentOver(fnIntent, readsOrdersBy(["tenant"]))],
      [
        readingOrders(
          fnCode,
          [{ type: "input", inputRef: "tenant", path: [] }],
          TENANT_PARAMETER,
        ),
      ],
    );
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([]);
  });

  it("reports the source the code takes it from instead", () => {
    const result = checkIntentAgreement(
      [intentOver(restIntent, readsOrdersBy(["headers", "x-tenant-id"]))],
      [
        readingOrders(
          restCode,
          [{ type: "input", inputRef: "req", path: ["body", "tenantId"] }],
          REQUEST_PARAMETER,
        ),
      ],
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "valueFromElsewhere",
      severity: "error",
      intent: { name: "orders-list", outcomeId: "listed" },
    });
    expect(result.findings[0]?.message).toContain(
      "listed reads postgresql:orders with tenant_id taken from input.headers.x-tenant-id; listOrders takes it from input.body.tenantId (in the transition at line 12)",
    );
  });

  it("matches a header whatever case either side writes it in", () => {
    const result = checkIntentAgreement(
      [intentOver(restIntent, readsOrdersBy(["headers", "X-Tenant-Id"]))],
      [
        readingOrders(
          restCode,
          [
            {
              type: "input",
              inputRef: "req",
              path: ["headers", "x-tenant-id"],
            },
          ],
          REQUEST_PARAMETER,
        ),
      ],
    );
    expect(result.findings).toEqual([]);
  });

  it("spells what middleware put on the request as a path off the request", () => {
    const result = checkIntentAgreement(
      [intentOver(restIntent, readsOrdersBy(["auth", "tenantId"]))],
      [
        readingOrders(
          restCode,
          [{ type: "input", inputRef: "req", path: ["auth", "tenantId"] }],
          REQUEST_PARAMETER,
        ),
      ],
    );
    expect(result.findings).toEqual([]);
  });

  it("names a literal the code writes in place of the source", () => {
    const result = checkIntentAgreement(
      [intentOver(fnIntent, readsOrdersBy(["tenant"]))],
      [
        readingOrders(
          fnCode,
          [{ type: "literal", value: "t-1" }],
          TENANT_PARAMETER,
        ),
      ],
    );
    expect(result.findings[0]?.message).toContain(
      'listOrders takes it from the literal "t-1"',
    );
  });

  it("leaves the claim unchecked when the walk stopped where it cannot follow", () => {
    const result = checkIntentAgreement(
      [intentOver(fnIntent, readsOrdersBy(["tenant"]))],
      [
        readingOrders(
          fnCode,
          [{ type: "unresolved", sourceText: "decode(token)" }],
          TENANT_PARAMETER,
        ),
      ],
    );
    expect(result.findings).toEqual([]);
    expect(result.unchecked).toEqual([
      {
        intent: "orders-list",
        reason: "unreadValue",
        outcomeId: "listed",
        detail:
          "listed reads postgresql:orders with tenant_id taken from input.tenant: the walk from tenant_id stopped at `decode(token)`, which it cannot follow.",
      },
    ]);
  });

  it("leaves the claim unchecked when the summary records no source", () => {
    const result = checkIntentAgreement(
      [intentOver(fnIntent, readsOrdersBy(["tenant"]))],
      [readingOrders(fnCode, null, TENANT_PARAMETER)],
    );
    expect(result.unchecked.map((one) => one.detail)).toEqual([
      "listed reads postgresql:orders with tenant_id taken from input.tenant: nothing in the summary says where tenant_id comes from.",
    ]);
  });
});

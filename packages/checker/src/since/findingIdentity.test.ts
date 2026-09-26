import { describe, expect, it } from "vitest";

import { restBinding } from "@suss/behavioral-ir";

import { findingIdentity } from "./findingIdentity.js";

import type { Finding } from "@suss/behavioral-ir";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: "unhandledProviderCase",
    boundary: restBinding({
      transport: "http",
      recognition: "express",
      method: "POST",
      path: "/orders",
    }),
    provider: {
      summary: "src/orders/create.ts::post",
      transitionId: "post:response:409:4b7ea21",
      location: {
        file: "src/orders/create.ts",
        range: { start: 10, end: 23 },
        exportName: "post",
      },
    },
    consumer: {
      summary: "web/orders/submitOrder.ts::submitOrder",
      location: {
        file: "web/orders/submitOrder.ts",
        range: { start: 1, end: 13 },
        exportName: "submitOrder",
      },
    },
    description:
      "Provider produces status 409 but no consumer branch handles it",
    severity: "warning",
    ...overrides,
  };
}

describe("findingIdentity", () => {
  it("ignores where the units are in their files", () => {
    const moved = finding({
      provider: {
        ...finding().provider,
        location: {
          file: "src/orders/create.ts",
          range: { start: 42, end: 55 },
          exportName: "post",
        },
      },
    });

    expect(findingIdentity(moved)).toBe(findingIdentity(finding()));
  });

  it("ignores severity, so a finding a rule downgraded is still the same one", () => {
    expect(findingIdentity(finding({ severity: "info" }))).toBe(
      findingIdentity(finding()),
    );
  });

  it("treats descriptions that differ only in whitespace as the same", () => {
    const wrapped = finding({
      description:
        "Provider produces status 409\n  but no consumer branch handles it ",
    });

    expect(findingIdentity(wrapped)).toBe(findingIdentity(finding()));
  });

  it("tells apart findings on different transitions of one unit", () => {
    const other = finding({
      provider: {
        ...finding().provider,
        transitionId: "post:response:410:0a1b2c3",
      },
    });

    expect(findingIdentity(other)).not.toBe(findingIdentity(finding()));
  });

  it("tells apart the same finding at two boundaries", () => {
    const elsewhere = finding({
      boundary: restBinding({
        transport: "http",
        recognition: "express",
        method: "PUT",
        path: "/orders/:id",
      }),
    });

    expect(findingIdentity(elsewhere)).not.toBe(findingIdentity(finding()));
  });

  it("reads a route written with :id and with {id} as one boundary", () => {
    const colon = finding({
      boundary: restBinding({
        transport: "http",
        recognition: "express",
        method: "GET",
        path: "/orders/:id",
      }),
    });
    const braces = finding({
      boundary: restBinding({
        transport: "http",
        recognition: "openapi",
        method: "GET",
        path: "/orders/{id}",
      }),
    });

    expect(findingIdentity(colon)).toBe(findingIdentity(braces));
  });

  it("tells apart two consumers of one provider status", () => {
    const secondClient = finding({
      consumer: {
        ...finding().consumer,
        summary: "web/orders/reorder.ts::reorder",
      },
    });

    expect(findingIdentity(secondClient)).not.toBe(findingIdentity(finding()));
  });
});

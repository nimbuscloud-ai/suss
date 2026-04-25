import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
} from "../__fixtures__/pairs.js";
import { checkSemanticBridging } from "./semanticBridging.js";

import type { Predicate, TypeShape, ValueRef } from "@suss/behavioral-ir";

// Helpers
const record = (props: Record<string, TypeShape>): TypeShape => ({
  type: "record",
  properties: props,
});
const literal = (v: string | number | boolean): TypeShape => ({
  type: "literal",
  value: v,
});
const text: TypeShape = { type: "text" };

// A consumer predicate that tests result.body.field === value
function bodyFieldEq(
  field: string,
  value: string | number | boolean,
): Predicate {
  return {
    type: "comparison",
    op: "eq",
    left: {
      type: "derived",
      from: {
        type: "derived",
        from: { type: "dependency", name: "client.getUser", accessChain: [] },
        derivation: { type: "propertyAccess", property: "body" },
      },
      derivation: { type: "propertyAccess", property: field },
    },
    right: { type: "literal", value },
  };
}

// A consumer predicate that tests result.body.field !== value
function bodyFieldNeq(
  field: string,
  value: string | number | boolean,
): Predicate {
  return {
    type: "negation",
    operand: bodyFieldEq(field, value),
  };
}

describe("checkSemanticBridging", () => {
  it("emits finding when provider has distinguishing literal that consumer ignores (the motivating example)", () => {
    // Provider: two 200 transitions
    //   1. user.deletedAt → 200 with body { status: "deleted", id, name }
    //   2. default         → 200 with body { status: "active", id, name }
    const p = provider("getUser", [
      transition("t-200-deleted", {
        conditions: [
          {
            type: "truthinessCheck",
            subject: {
              type: "derived",
              from: {
                type: "dependency",
                name: "db.findById",
                accessChain: [],
              },
              derivation: { type: "propertyAccess", property: "deletedAt" },
            },
            negated: false,
          },
        ],
        output: response(
          200,
          record({
            status: literal("deleted"),
            id: text,
            name: text,
          }),
        ),
      }),
      transition("t-200-active", {
        output: response(
          200,
          record({
            status: literal("active"),
            id: text,
            name: text,
          }),
        ),
        isDefault: true,
      }),
    ]);

    // Consumer: handles 200 without testing body.status
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Should flag that body.status = "deleted" is not tested by consumer
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const deletedFinding = findings.find((f) =>
      f.description.includes("deleted"),
    );
    expect(deletedFinding).toBeDefined();
    expect(deletedFinding?.severity).toBe("warning");
    expect(deletedFinding?.provider.transitionId).toBe("t-200-deleted");
    expect(deletedFinding?.description).toContain("status");
  });

  it("emits no finding when consumer tests for the distinguishing literal", () => {
    const p = provider("getUser", [
      transition("t-200-deleted", {
        conditions: [],
        output: response(200, record({ status: literal("deleted"), id: text })),
      }),
      transition("t-200-active", {
        output: response(200, record({ status: literal("active"), id: text })),
        isDefault: true,
      }),
    ]);

    // Consumer tests body.status === "deleted"
    const c = consumer("UserPage", [
      transition("ct-200-deleted", {
        conditions: [statusEq(200), bodyFieldEq("status", "deleted")],
        output: { type: "return", value: null },
      }),
      transition("ct-200-active", {
        conditions: [statusEq(200), bodyFieldEq("status", "active")],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    expect(findings).toEqual([]);
  });

  it("emits no finding when provider has only one transition per status", () => {
    const p = provider("simple", [
      transition("t-200", {
        output: response(200, record({ name: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("Client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    expect(checkSemanticBridging(p, c)).toEqual([]);
  });

  it("emits no finding when provider bodies are structurally identical (all dynamic)", () => {
    const p = provider("getUser", [
      transition("t-200-a", {
        output: response(200, record({ name: text, email: text })),
      }),
      transition("t-200-b", {
        output: response(200, record({ name: text, email: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    // Same fields, same types, no literals — nothing to distinguish
    expect(checkSemanticBridging(p, c)).toEqual([]);
  });

  it("detects nested distinguishing literals (body.user.role)", () => {
    const p = provider("getUser", [
      transition("t-200-admin", {
        output: response(
          200,
          record({ user: record({ role: literal("admin"), name: text }) }),
        ),
      }),
      transition("t-200-regular", {
        output: response(
          200,
          record({ user: record({ role: literal("user"), name: text }) }),
        ),
        isDefault: true,
      }),
    ]);

    const c = consumer("Dashboard", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].description).toContain("user.role");
  });

  it("only emits one finding per provider transition even with multiple distinguishing literals", () => {
    const p = provider("getUser", [
      transition("t-200-special", {
        output: response(
          200,
          record({
            type: literal("special"),
            tier: literal("premium"),
            name: text,
          }),
        ),
      }),
      transition("t-200-normal", {
        output: response(
          200,
          record({
            type: literal("normal"),
            tier: literal("free"),
            name: text,
          }),
        ),
        isDefault: true,
      }),
    ]);

    const c = consumer("Client", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Two provider transitions, each with distinguishing literals,
    // but only one finding per transition
    const forSpecial = findings.filter(
      (f) => f.provider.transitionId === "t-200-special",
    );
    expect(forSpecial).toHaveLength(1);
  });

  it("suppresses finding when consumer uses truthiness check on a distinguishing field", () => {
    // Provider: two 200s distinguished by deletedAt literal
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(
          200,
          record({
            id: text,
            deletedAt: literal("2024-01-01"),
            status: literal("deleted"),
          }),
        ),
      }),
      transition("t-200-active", {
        output: response(200, record({ id: text, status: literal("active") })),
        isDefault: true,
      }),
    ]);

    // Consumer: truthiness check on body.deletedAt
    const truthinessCheck: Predicate = {
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: {
          type: "derived",
          from: {
            type: "dependency",
            name: "client.getUser",
            accessChain: [],
          },
          derivation: { type: "propertyAccess", property: "body" },
        },
        derivation: { type: "propertyAccess", property: "deletedAt" },
      },
      negated: false,
    };
    const c = consumer("UserPage", [
      transition("ct-200-deleted", {
        conditions: [statusEq(200), truthinessCheck],
        output: { type: "return", value: null },
      }),
      transition("ct-200-default", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Truthiness check on deletedAt covers the t-200-deleted sub-case
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-deleted"),
    ).toBe(false);
  });

  it("recognizes fetch .json() body accessor for field tests", () => {
    // Provider: two 200s with distinguishing status literal
    const p = provider("getHealth", [
      transition("t-200-down", {
        output: response(200, record({ status: literal("down") })),
      }),
      transition("t-200-up", {
        output: response(200, record({ status: literal("up") })),
        isDefault: true,
      }),
    ]);

    // Consumer: tests data.status === "down" where data = res.json()
    const dataStatusRef: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "res.json", accessChain: [] },
      derivation: { type: "propertyAccess", property: "status" },
    };
    const c = consumer("HealthCheck", [
      transition("ct-200-down", {
        conditions: [
          statusEq(200),
          {
            type: "comparison",
            op: "eq",
            left: dataStatusRef,
            right: { type: "literal", value: "down" },
          },
        ],
        output: { type: "return", value: null },
      }),
      transition("ct-200-up", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Consumer tests for "down" through .json() accessor — no finding for t-200-down
    expect(findings.some((f) => f.provider.transitionId === "t-200-down")).toBe(
      false,
    );
  });

  it("emits no finding when consumer matches any distinguishing literal (not all)", () => {
    // Provider transition has both type and tier as distinguishing literals
    // Consumer only tests for type — that's sufficient awareness
    const p = provider("getUser", [
      transition("t-200-special", {
        output: response(
          200,
          record({
            type: literal("special"),
            tier: literal("premium"),
            name: text,
          }),
        ),
      }),
      transition("t-200-normal", {
        output: response(
          200,
          record({
            type: literal("normal"),
            tier: literal("free"),
            name: text,
          }),
        ),
        isDefault: true,
      }),
    ]);

    const c = consumer("Client", [
      transition("ct-200-special", {
        conditions: [statusEq(200), bodyFieldEq("type", "special")],
        output: { type: "return", value: null },
      }),
      transition("ct-200-default", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Consumer tests type but not tier — still covers the sub-case
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-special"),
    ).toBe(false);
  });

  it("suppresses finding when consumer uses negated comparison (!== covers the other value)", () => {
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(200, record({ status: literal("deleted"), id: text })),
      }),
      transition("t-200-active", {
        output: response(200, record({ status: literal("active"), id: text })),
        isDefault: true,
      }),
    ]);

    // Consumer: !== "active" handles deleted, === "active" handles active
    const c = consumer("UserPage", [
      transition("ct-200-not-active", {
        conditions: [statusEq(200), bodyFieldNeq("status", "active")],
        output: { type: "return", value: null },
      }),
      transition("ct-200-active", {
        conditions: [statusEq(200), bodyFieldEq("status", "active")],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    expect(findings).toEqual([]);
  });

  it("handles comparison(neq) directly (not just negation wrapping eq)", () => {
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(200, record({ status: literal("deleted"), id: text })),
      }),
      transition("t-200-active", {
        output: response(200, record({ status: literal("active"), id: text })),
        isDefault: true,
      }),
    ]);

    // Direct neq comparison (body.status !== "active")
    const neqPredicate: Predicate = {
      type: "comparison",
      op: "neq",
      left: {
        type: "derived",
        from: {
          type: "derived",
          from: {
            type: "dependency",
            name: "client.getUser",
            accessChain: [],
          },
          derivation: { type: "propertyAccess", property: "body" },
        },
        derivation: { type: "propertyAccess", property: "status" },
      },
      right: { type: "literal", value: "active" },
    };

    const c = consumer("UserPage", [
      transition("ct-200-not-active", {
        conditions: [statusEq(200), neqPredicate],
        output: { type: "return", value: null },
      }),
      transition("ct-200-active", {
        conditions: [statusEq(200), bodyFieldEq("status", "active")],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-deleted"),
    ).toBe(false);
  });

  it("detects field-presence discrimination when bodies differ structurally", () => {
    // Provider: one transition has deletedAt, the other doesn't.
    // No literals differ — the structural difference is the discriminator.
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(
          200,
          record({ id: text, name: text, deletedAt: text }),
        ),
      }),
      transition("t-200-active", {
        output: response(200, record({ id: text, name: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.description.includes("deletedAt"))).toBe(
      true,
    );
  });

  it("suppresses field-presence finding when consumer uses truthiness check on the field", () => {
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(
          200,
          record({ id: text, name: text, deletedAt: text }),
        ),
      }),
      transition("t-200-active", {
        output: response(200, record({ id: text, name: text })),
        isDefault: true,
      }),
    ]);

    const truthinessCheck: Predicate = {
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: {
          type: "derived",
          from: {
            type: "dependency",
            name: "client.getUser",
            accessChain: [],
          },
          derivation: { type: "propertyAccess", property: "body" },
        },
        derivation: { type: "propertyAccess", property: "deletedAt" },
      },
      negated: false,
    };

    const c = consumer("UserPage", [
      transition("ct-200-deleted", {
        conditions: [statusEq(200), truthinessCheck],
        output: { type: "return", value: null },
      }),
      transition("ct-200-default", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Truthiness check on deletedAt covers the field-presence discriminator
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-deleted"),
    ).toBe(false);
  });

  it("skips field-presence check when literal discrimination is available", () => {
    // Provider has both literal and field-presence differences.
    // Literal discrimination takes priority — more specific signal.
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(
          200,
          record({
            id: text,
            status: literal("deleted"),
            deletedAt: text,
          }),
        ),
      }),
      transition("t-200-active", {
        output: response(200, record({ id: text, status: literal("active") })),
        isDefault: true,
      }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    const findings = checkSemanticBridging(p, c);
    // Finding mentions literal "deleted", not field presence "deletedAt"
    const finding = findings.find(
      (f) => f.provider.transitionId === "t-200-deleted",
    );
    expect(finding).toBeDefined();
    expect(finding?.description).toContain("deleted");
    expect(finding?.description).not.toContain("other transitions lack");
  });
});

import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
} from "./__fixtures__/pairs.js";
import { checkSemanticBridging } from "./semantic-bridging.js";

import type { Predicate, TypeShape } from "@suss/behavioral-ir";

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

// A consumer predicate that tests result.body.status === "deleted"
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

  it("emits no finding when provider body has no literals (all dynamic)", () => {
    const p = provider("getUser", [
      transition("t-200-a", {
        output: response(200, record({ name: text, email: text })),
      }),
      transition("t-200-b", {
        output: response(200, record({ name: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    // No literal fields to distinguish — no semantic bridging findings
    // (field presence difference is caught by checkBodyCompatibility)
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
});

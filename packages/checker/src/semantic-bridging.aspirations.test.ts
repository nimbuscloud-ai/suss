// semantic-bridging.aspirations.test.ts
//
// Tests that document the current limitations of semantic condition bridging.
// Each test describes:
//   - What the code pattern is
//   - What the IDEAL behavior would be (commented)
//   - What the CURRENT behavior is (asserted)
//
// As capabilities improve, these tests should be updated: change the assertion
// to match the ideal behavior and move the test to the main test file.

import { describe, expect, it } from "vitest";

import {
  consumer,
  provider,
  response,
  statusEq,
  transition,
} from "./__fixtures__/pairs.js";
import { checkSemanticBridging } from "./semantic-bridging.js";

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
const ref = (name: string): TypeShape => ({ type: "ref", name });

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

function bodyFieldNeq(
  field: string,
  value: string | number | boolean,
): Predicate {
  return {
    type: "negation",
    operand: bodyFieldEq(field, value),
  };
}

// ---------------------------------------------------------------------------
// Aspiration 1: Type-widened literals (no `as const`)
// ---------------------------------------------------------------------------
// RECLASSIFIED: The extractor's syntactic pass DOES preserve literals
// without `as const` for direct object literals, variable bindings, and
// single-return local functions. Verified by tests in shapes.test.ts.
//
// The remaining gap is bodies constructed through multi-return functions,
// method calls, or cross-module functions — these fall through to the
// type-checker fallback which sees `string` instead of `"deleted"`.
// This is the same underlying issue as aspiration 4 (Level 6 territory).

describe("aspiration: type-widened literals (via multi-return function)", () => {
  it("cannot discriminate when shapes are widened to text (Level 6 gap)", () => {
    // This scenario only occurs when the body goes through a code path
    // the AST resolver can't inline (multi-return function, method call,
    // cross-module function). For direct object literals, the syntactic
    // pass preserves the literal without `as const`.
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(200, record({ status: text, id: text })),
      }),
      transition("t-200-active", {
        output: response(200, record({ status: text, id: text })),
        isDefault: true,
      }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    // Bodies are structurally identical (same fields, same types) →
    // no literal or field-presence discrimination possible.
    expect(checkSemanticBridging(p, c)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aspiration 2: Negated comparisons as proxy
// ---------------------------------------------------------------------------

describe("RESOLVED: negated comparisons", () => {
  it("recognizes !== 'active' as covering the 'deleted' case", () => {
    // RESOLVED: The checker now extracts negated equality tests
    // (comparison(neq) and negation(comparison(eq))). A negated test
    // !== X covers any distinguishing literal that isn't X.
    //
    // !== "active" at path ["status"] matches any literal at ["status"]
    // whose value is not "active" — including "deleted".
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(200, record({ status: literal("deleted"), id: text })),
      }),
      transition("t-200-active", {
        output: response(200, record({ status: literal("active"), id: text })),
        isDefault: true,
      }),
    ]);
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

    // !== "active" covers "deleted", and === "active" covers "active"
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aspiration 3: Field presence as discriminator
// ---------------------------------------------------------------------------

describe("RESOLVED: field presence discrimination", () => {
  it("detects discrimination by field existence (deletedAt present vs absent)", () => {
    // RESOLVED: The checker now detects structural differences between
    // sibling transition bodies. When a field exists in one transition
    // but not another, it's a presence discriminator. If no consumer
    // test covers that field, a finding is emitted.
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
    // t-200-deleted has deletedAt that t-200-active lacks
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-deleted"),
    ).toBe(true);
    expect(findings.some((f) => f.description.includes("deletedAt"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Aspiration 4: Response body behind function calls
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Aspiration 4: Response body behind function calls
// ---------------------------------------------------------------------------
// RECLASSIFIED: The extractor DOES expand named interfaces into records
// (User → { id: text, name: text }). And single-return local functions
// ARE inlined by resolveCall, preserving literal narrowness.
//
// Ref shapes only appear when:
//   - The function has multiple return statements
//   - The callee is a method (obj.buildUser()) not a bare function
//   - The function is cross-module with no visible body
//
// These are all Level 6 (local function inlining) territory.

describe("aspiration: body constructed by multi-return or method helper", () => {
  it("cannot discriminate ref shapes (requires Level 6 inlining)", () => {
    // This only happens when the AST resolver can't inline the function.
    // Single-return local functions DO preserve literal narrowness.
    // Named interfaces expand to records, not refs.
    const p = provider("getUser", [
      transition("t-200-deleted", {
        output: response(200, ref("DeletedUser")),
      }),
      transition("t-200-active", {
        output: response(200, ref("ActiveUser")),
        isDefault: true,
      }),
    ]);
    const c = consumer("UserPage", [
      transition("ct-200", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
      }),
    ]);

    // Ref shapes are opaque — no structural information to discriminate
    expect(checkSemanticBridging(p, c)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aspiration 5: Consumer accessing through .json() (fetch pattern)
// ---------------------------------------------------------------------------

describe("RESOLVED: fetch .json() response pattern", () => {
  it("bridges through json() intermediate — recognizes .json() as body accessor", () => {
    // RESOLVED: The checker now recognizes that dependencies whose name
    // ends with ".json" (e.g., res.json()) are body accessors. Properties
    // accessed on the return value are treated as body-relative paths.
    //
    // Remaining limitation: only ".json()" is recognized. Other body
    // accessor patterns (custom deserializers, .text() + JSON.parse, etc.)
    // would need to be added to isBodyAccessorCall.

    const dataStatusRef: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "res.json", accessChain: [] },
      derivation: { type: "propertyAccess", property: "status" },
    };
    const consumerPredicate: Predicate = {
      type: "comparison",
      op: "eq",
      left: dataStatusRef,
      right: { type: "literal", value: "down" },
    };

    const p = provider("getHealth", [
      transition("t-200-down", {
        output: response(200, record({ status: literal("down") })),
      }),
      transition("t-200-up", {
        output: response(200, record({ status: literal("up") })),
        isDefault: true,
      }),
    ]);
    const c = consumer("HealthCheck", [
      transition("ct-200-down", {
        conditions: [statusEq(200), consumerPredicate],
        output: { type: "return", value: null },
      }),
      transition("ct-200-up", {
        conditions: [statusEq(200)],
        output: { type: "return", value: null },
        isDefault: true,
      }),
    ]);

    const findings = checkSemanticBridging(p, c);

    // Consumer tests status === "down" through .json() accessor — finding
    // suppressed for t-200-down
    expect(findings.some((f) => f.provider.transitionId === "t-200-down")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Aspiration 6: Truthiness check as discriminator
// ---------------------------------------------------------------------------

describe("RESOLVED: truthiness check on body field", () => {
  it("bridges when consumer uses truthiness check on a distinguishing field", () => {
    // RESOLVED: Truthiness checks on body fields are now extracted as
    // ConsumerFieldTest entries. A truthiness check on a path matches
    // any distinguishing literal at that path, since the consumer IS
    // making a distinction on that field.
    //
    // Remaining limitation: the complementary sub-case (t-200-active)
    // still emits a finding because no consumer test explicitly covers
    // status = "active". The default branch implicitly handles it, but
    // the checker doesn't reason about default-as-complement yet.
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

    // Truthiness check on deletedAt covers the deleted sub-case
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-deleted"),
    ).toBe(false);

    // Active sub-case still emits a finding (complement reasoning not yet implemented)
    expect(
      findings.some((f) => f.provider.transitionId === "t-200-active"),
    ).toBe(true);
  });
});

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

describe("aspiration: type-widened literals", () => {
  it("does NOT detect discrimination when provider body field is widened to text", () => {
    // Provider returns { status: "deleted" } and { status: "active" },
    // but the shapes show `text` instead of `literal` because the source
    // didn't use `as const` and the type checker widened the values.
    //
    // IDEAL: The extractor's syntactic pass should preserve the literal
    // even without `as const` (it reads the AST node, not the type).
    // The checker should then detect the discrimination.
    //
    // CURRENT: When shapes are `text`, no literals to compare → no finding.
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

    // CURRENT: no findings (both bodies look identical)
    expect(checkSemanticBridging(p, c)).toEqual([]);

    // IDEAL: should detect that these are distinct behavioral cases
    // even though the type-level shapes are the same, because the
    // provider conditions differ.
  });
});

// ---------------------------------------------------------------------------
// Aspiration 2: Negated comparisons as proxy
// ---------------------------------------------------------------------------

describe("aspiration: negated comparisons", () => {
  it("does NOT recognize !== 'active' as covering the 'deleted' case", () => {
    // Provider has two 200 sub-cases: status = "deleted" vs "active".
    // Consumer tests `body.status !== "active"` to handle the deleted case.
    //
    // IDEAL: The checker should recognize that `!== "active"` in a
    // two-variant universe covers the "deleted" case.
    //
    // CURRENT: The checker only matches exact (path, value) pairs.
    // `!== "active"` is a negated comparison, not an equality match
    // against "deleted", so it doesn't suppress the finding.
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

    // CURRENT: emits a finding for "deleted" because the consumer
    // tests for !== "active", not === "deleted"
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.description.includes("deleted"))).toBe(true);

    // IDEAL: no finding — the consumer's !== "active" covers the
    // "deleted" case when the provider's status is a closed union
    // of "active" | "deleted".
  });
});

// ---------------------------------------------------------------------------
// Aspiration 3: Field presence as discriminator
// ---------------------------------------------------------------------------

describe("aspiration: field presence discrimination", () => {
  it("does NOT detect discrimination by field existence (deletedAt present vs absent)", () => {
    // Provider: one transition includes deletedAt, the other doesn't.
    // This is a structural discriminator — the consumer should check
    // whether deletedAt exists.
    //
    // IDEAL: The checker should recognize that the two body shapes
    // differ structurally (one has deletedAt, the other doesn't) and
    // warn if the consumer doesn't test for it.
    //
    // CURRENT: No literal fields differ → no semantic bridging finding.
    // (Field presence difference IS caught by checkBodyCompatibility
    // if the consumer reads deletedAt, but not as a "distinguishing
    // behavioral signal" warning.)
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

    // CURRENT: no semantic bridging finding (no literals)
    expect(checkSemanticBridging(p, c)).toEqual([]);

    // IDEAL: should warn that the provider has structurally different
    // body shapes for status 200 (one has deletedAt, the other doesn't)
    // and the consumer doesn't distinguish them.
  });
});

// ---------------------------------------------------------------------------
// Aspiration 4: Response body behind function calls
// ---------------------------------------------------------------------------

describe("aspiration: body constructed by helper function", () => {
  it("does NOT detect discrimination when body is built by a function call", () => {
    // Provider: body is { type: "ref", name: "User" } because the
    // shape extractor couldn't resolve through the function call.
    //
    // IDEAL: For local helpers, the extractor would inline the function
    // body and extract the literal shape. For external functions, the
    // type checker's return type would be used.
    //
    // CURRENT: ref shapes are opaque → no literals → no finding.
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

    // CURRENT: no finding (ref shapes are opaque)
    expect(checkSemanticBridging(p, c)).toEqual([]);

    // IDEAL: if DeletedUser and ActiveUser have different literal
    // fields, should detect the discrimination. This requires
    // resolving ref shapes to their structural definitions.
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

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

describe("aspiration: fetch .json() response pattern", () => {
  it("does NOT bridge through json() intermediate (no 'body' in property chain)", () => {
    // In fetch patterns, the consumer does:
    //   const res = await fetch(url);
    //   const data = await res.json();
    //   if (data.status === "deleted") { ... }
    //
    // The consumer predicate's subject chain goes through `data` (assigned
    // from res.json()) not through `.body`. The checker looks for "body"
    // in the chain to compute the body-relative path.
    //
    // IDEAL: The checker should recognize that `res.json()` is the response
    // body accessor for fetch, and `data.status` is equivalent to
    // `response.body.status` for body-relative path matching.
    //
    // CURRENT: No "body" in the chain → tryExtractFieldTest returns null
    // → no consumer field test → finding emitted even though consumer
    // actually handles the case.

    // Simulate: consumer predicate with chain ["status"] (no "body" prefix)
    const dataStatusRef: ValueRef = {
      type: "derived",
      from: { type: "dependency", name: "res.json", accessChain: [] },
      derivation: { type: "propertyAccess", property: "status" },
    };
    const consumerPredicate: Predicate = {
      type: "comparison",
      op: "eq",
      left: dataStatusRef,
      right: { type: "literal", value: "deleted" },
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

    // CURRENT: emits finding because consumer's chain doesn't go through "body"
    // so tryExtractFieldTest doesn't extract a ConsumerFieldTest
    expect(findings.length).toBeGreaterThanOrEqual(1);

    // IDEAL: no finding — the consumer IS testing the right field,
    // just through a different accessor pattern than .body
  });
});

// ---------------------------------------------------------------------------
// Aspiration 6: Truthiness check as discriminator
// ---------------------------------------------------------------------------

describe("aspiration: truthiness check on body field", () => {
  it("does NOT bridge when consumer uses truthiness check instead of equality", () => {
    // Consumer does: if (result.body.deletedAt) { handle deleted }
    // This is a truthiness check, not an equality comparison.
    //
    // IDEAL: Recognize that a truthiness check on a body field that
    // exists in one provider transition but not another is a valid
    // sub-case distinction.
    //
    // CURRENT: Only equality comparisons with literal values are
    // extracted as consumer field tests.
    const truthinessCheck: Predicate = {
      type: "truthinessCheck",
      subject: {
        type: "derived",
        from: {
          type: "derived",
          from: { type: "dependency", name: "client.getUser", accessChain: [] },
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

    // CURRENT: emits finding for "deleted" because consumer's
    // truthiness check isn't recognized as matching a literal
    expect(findings.some((f) => f.description.includes("deleted"))).toBe(true);

    // IDEAL: no finding — the consumer IS distinguishing the deleted
    // case via truthiness check on deletedAt, even though it doesn't
    // test the exact literal value.
  });
});

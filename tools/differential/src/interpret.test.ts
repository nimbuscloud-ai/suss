import { describe, expect, it } from "vitest";

import { evalConditions, evalPredicate, evalValueRef } from "./interpret.js";

import type { Predicate, ValueRef } from "@suss/behavioral-ir";

const input = (name: string): ValueRef => ({
  type: "input",
  inputRef: name,
  path: [],
});

const prop = (from: ValueRef, property: string): ValueRef => ({
  type: "derived",
  from,
  derivation: { type: "propertyAccess", property },
});

const lit = (value: string | number | boolean | null): ValueRef => ({
  type: "literal",
  value,
});

const reqField = (container: string, key: string): ValueRef =>
  prop(prop(input("req"), container), key);

const env = (req: unknown) => ({ req });

describe("evalValueRef", () => {
  it("resolves derived property chains off inputs", () => {
    const ref = reqField("query", "q");
    expect(evalValueRef(ref, env({ query: { q: "hello" } }))).toEqual({
      type: "known",
      value: "hello",
    });
  });

  it("reads missing properties as known undefined, not unknown", () => {
    const ref = reqField("query", "q");
    expect(evalValueRef(ref, env({ query: {} }))).toEqual({
      type: "known",
      value: undefined,
    });
  });

  it("abstains when the base of a read is not an object", () => {
    const ref = prop(prop(input("req"), "query"), "q");
    expect(evalValueRef(ref, env({ query: undefined }))).toEqual({
      type: "unknown",
    });
  });

  it("abstains on dependency, state, and unresolved refs", () => {
    const deps: ValueRef[] = [
      { type: "dependency", name: "db.findById", accessChain: [] },
      { type: "state", name: "counter" },
      { type: "unresolved", sourceText: "mystery" },
    ];
    for (const ref of deps) {
      expect(evalValueRef(ref, env({}))).toEqual({ type: "unknown" });
    }
  });

  it("abstains through methodCall and awaited derivations", () => {
    const call: ValueRef = {
      type: "derived",
      from: input("req"),
      derivation: { type: "methodCall", method: "json", args: [] },
    };
    expect(evalValueRef(call, env({}))).toEqual({ type: "unknown" });
  });

  it("walks input paths when present", () => {
    const ref: ValueRef = {
      type: "input",
      inputRef: "req",
      path: ["query", "q"],
    };
    expect(evalValueRef(ref, env({ query: { q: "x" } }))).toEqual({
      type: "known",
      value: "x",
    });
  });
});

describe("evalPredicate", () => {
  it("evaluates truthiness with negation", () => {
    const pred: Predicate = {
      type: "truthinessCheck",
      subject: reqField("query", "q"),
      negated: true,
    };
    expect(evalPredicate(pred, env({ query: { q: "" } }))).toBe("true");
    expect(evalPredicate(pred, env({ query: { q: "x" } }))).toBe("false");
  });

  it("evaluates strict equality comparisons", () => {
    const pred: Predicate = {
      type: "comparison",
      left: reqField("headers", "authorization"),
      op: "eq",
      right: lit("admin"),
    };
    expect(
      evalPredicate(pred, env({ headers: { authorization: "admin" } })),
    ).toBe("true");
    expect(
      evalPredicate(pred, env({ headers: { authorization: "user" } })),
    ).toBe("false");
  });

  it("abstains on ordered comparison across mixed types", () => {
    const pred: Predicate = {
      type: "comparison",
      left: reqField("query", "page"),
      op: "gt",
      right: lit(3),
    };
    // page is a string; 'gt' across string/number would invoke JS
    // coercion — the interpreter abstains instead of modeling it.
    expect(evalPredicate(pred, env({ query: { page: "5" } }))).toBe("unknown");
  });

  it("evaluates propertyExists against concrete objects", () => {
    const pred: Predicate = {
      type: "propertyExists",
      subject: prop(input("req"), "query"),
      property: "q",
      negated: false,
    };
    expect(evalPredicate(pred, env({ query: { q: "" } }))).toBe("true");
    expect(evalPredicate(pred, env({ query: {} }))).toBe("false");
  });

  it("abstains on opaque and call predicates — never guesses", () => {
    const opaque: Predicate = {
      type: "opaque",
      sourceText: "await isAllowed(req)",
      reason: "complexExpression",
    };
    const call: Predicate = {
      type: "call",
      callee: "isActive",
      args: [reqField("query", "q")],
    };
    expect(evalPredicate(opaque, env({ query: { q: "x" } }))).toBe("unknown");
    expect(evalPredicate(call, env({ query: { q: "x" } }))).toBe("unknown");
  });

  it("propagates unknown through negation", () => {
    const pred: Predicate = {
      type: "negation",
      operand: {
        type: "opaque",
        sourceText: "x",
        reason: "complexExpression",
      },
    };
    expect(evalPredicate(pred, env({}))).toBe("unknown");
  });

  it("applies Kleene semantics to compounds", () => {
    const unknown: Predicate = {
      type: "opaque",
      sourceText: "?",
      reason: "complexExpression",
    };
    const truePred: Predicate = {
      type: "truthinessCheck",
      subject: lit("x"),
      negated: false,
    };
    const falsePred: Predicate = {
      type: "truthinessCheck",
      subject: lit(""),
      negated: false,
    };

    // false && unknown → false (short-circuit dominates the unknown)
    expect(
      evalPredicate(
        { type: "compound", op: "and", operands: [falsePred, unknown] },
        env({}),
      ),
    ).toBe("false");
    // true && unknown → unknown
    expect(
      evalPredicate(
        { type: "compound", op: "and", operands: [truePred, unknown] },
        env({}),
      ),
    ).toBe("unknown");
    // true || unknown → true
    expect(
      evalPredicate(
        { type: "compound", op: "or", operands: [truePred, unknown] },
        env({}),
      ),
    ).toBe("true");
    // false || unknown → unknown
    expect(
      evalPredicate(
        { type: "compound", op: "or", operands: [falsePred, unknown] },
        env({}),
      ),
    ).toBe("unknown");
  });
});

describe("evalConditions", () => {
  it("treats an empty condition list as true (unconditional transition)", () => {
    expect(evalConditions([], env({}))).toBe("true");
  });

  it("conjoins conditions with abstention", () => {
    const truePred: Predicate = {
      type: "truthinessCheck",
      subject: lit(1),
      negated: false,
    };
    const unknown: Predicate = {
      type: "opaque",
      sourceText: "?",
      reason: "complexExpression",
    };
    expect(evalConditions([truePred, unknown], env({}))).toBe("unknown");
  });
});

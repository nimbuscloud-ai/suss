import { describe, expect, it } from "vitest";

import { evalConditions, evalPredicate, evalValueRef } from "./interpret.js";

import type { Predicate, ValueRef } from "./index.js";

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
    // page is a string, and 'gt' across a string and a number would
    // invoke JS coercion, so the interpreter abstains instead.
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

  it("abstains on opaque and call predicates: never guesses", () => {
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

describe("evalPredicate: operator and type-check coverage", () => {
  const cmp = (
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
    left: ValueRef,
    right: ValueRef,
  ): Predicate => ({ type: "comparison", op, left, right });

  it("evaluates every ordered comparator on numbers", () => {
    expect(evalPredicate(cmp("gt", lit(3), lit(2)), env({}))).toBe("true");
    expect(evalPredicate(cmp("gte", lit(2), lit(2)), env({}))).toBe("true");
    expect(evalPredicate(cmp("lt", lit(3), lit(2)), env({}))).toBe("false");
    expect(evalPredicate(cmp("lte", lit(2), lit(3)), env({}))).toBe("true");
  });

  it("evaluates ordered comparators on strings and neq on both", () => {
    expect(evalPredicate(cmp("gt", lit("b"), lit("a")), env({}))).toBe("true");
    expect(evalPredicate(cmp("lt", lit("b"), lit("a")), env({}))).toBe("false");
    expect(evalPredicate(cmp("neq", lit("a"), lit("b")), env({}))).toBe("true");
    expect(evalPredicate(cmp("neq", lit(1), lit(1)), env({}))).toBe("false");
  });

  it("abstains when either comparison side is unknown", () => {
    const dep: ValueRef = { type: "dependency", name: "db", accessChain: [] };
    expect(evalPredicate(cmp("eq", dep, lit(1)), env({}))).toBe("unknown");
    expect(evalPredicate(cmp("gt", lit(1), dep), env({}))).toBe("unknown");
  });

  it("evaluates typeof checks and abstains on class-name checks", () => {
    const typeCheck = (subject: ValueRef, expectedType: string): Predicate => ({
      type: "typeCheck",
      subject,
      expectedType,
    });
    expect(evalPredicate(typeCheck(lit("x"), "string"), env({}))).toBe("true");
    expect(evalPredicate(typeCheck(lit(1), "string"), env({}))).toBe("false");
    // An instanceof-style check: the env cannot see prototype chains.
    expect(evalPredicate(typeCheck(lit("x"), "Date"), env({}))).toBe("unknown");
    // Unknown subject abstains even for a typeof-style check.
    expect(
      evalPredicate(
        typeCheck({ type: "unresolved", sourceText: "v" }, "string"),
        env({}),
      ),
    ).toBe("unknown");
  });

  it("evaluates nullCheck on null, undefined, and values, with negation", () => {
    const nullCheck = (subject: ValueRef, negated: boolean): Predicate => ({
      type: "nullCheck",
      subject,
      negated,
    });
    expect(evalPredicate(nullCheck(lit(null), false), env({}))).toBe("true");
    expect(
      evalPredicate(
        nullCheck(reqField("query", "id"), false),
        env({ query: {} }),
      ),
    ).toBe("true");
    expect(evalPredicate(nullCheck(lit("x"), false), env({}))).toBe("false");
    expect(evalPredicate(nullCheck(lit("x"), true), env({}))).toBe("true");
    expect(
      evalPredicate(
        nullCheck({ type: "state", name: "cache" }, false),
        env({}),
      ),
    ).toBe("unknown");
  });

  it("propertyExists abstains on primitives and honors negation", () => {
    const exists = (
      subject: ValueRef,
      property: string,
      negated: boolean,
    ): Predicate => ({ type: "propertyExists", subject, property, negated });
    expect(evalPredicate(exists(lit("s"), "length", false), env({}))).toBe(
      "unknown",
    );
    const req = env({ body: { email: "a" } });
    expect(
      evalPredicate(exists(prop(input("req"), "body"), "email", false), req),
    ).toBe("true");
    expect(
      evalPredicate(exists(prop(input("req"), "body"), "email", true), req),
    ).toBe("false");
  });

  it("returns unknown for absent input roots", () => {
    expect(evalValueRef(input("ctx"), env({}))).toEqual({ type: "unknown" });
  });
});

describe("interpreter: exhaustive abstention edges", () => {
  it("propagates unknown through chained property reads", () => {
    // First read is off a primitive (unknown); the second read must
    // short-circuit on the already-unknown base.
    const chained = prop(prop(input("req"), "id"), "length");
    expect(evalValueRef(chained, env({ id: 7 }))).toEqual({ type: "unknown" });
    // A read whose base is ALREADY unknown (dependency) short-circuits.
    const offDependency = prop(
      { type: "dependency", name: "db", accessChain: [] },
      "rows",
    );
    expect(evalValueRef(offDependency, env({}))).toEqual({ type: "unknown" });
  });

  it("resolves destructured and index-access derivations", () => {
    const destructured: ValueRef = {
      type: "derived",
      from: input("req"),
      derivation: { type: "destructured", field: "body" },
    };
    expect(evalValueRef(destructured, env({ body: 1 }))).toEqual({
      type: "known",
      value: 1,
    });
    const indexed: ValueRef = {
      type: "derived",
      from: input("req"),
      derivation: { type: "indexAccess", index: 0 },
    };
    expect(evalValueRef(indexed, { req: ["first"] })).toEqual({
      type: "known",
      value: "first",
    });
  });

  it("abstains on a direct awaited derivation", () => {
    const awaited: ValueRef = {
      type: "derived",
      from: input("req"),
      derivation: { type: "awaited" },
    };
    expect(evalValueRef(awaited, env({}))).toEqual({ type: "unknown" });
  });

  it("resolves or-compounds to false when every arm is false", () => {
    const falsePred: Predicate = {
      type: "truthinessCheck",
      subject: lit(""),
      negated: false,
    };
    expect(
      evalPredicate(
        { type: "compound", op: "or", operands: [falsePred, falsePred] },
        env({}),
      ),
    ).toBe("false");
  });

  it("truthiness and propertyExists abstain on unknown subjects", () => {
    const dep: ValueRef = { type: "dependency", name: "db", accessChain: [] };
    expect(
      evalPredicate(
        { type: "truthinessCheck", subject: dep, negated: false },
        env({}),
      ),
    ).toBe("unknown");
    expect(
      evalPredicate(
        { type: "propertyExists", subject: dep, property: "x", negated: false },
        env({}),
      ),
    ).toBe("unknown");
  });
});

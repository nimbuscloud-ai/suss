// interpret.ts — a three-valued interpreter for the summary IR.
//
// Evaluates `Predicate` / `ValueRef` trees against a concrete
// environment (a request, a props object, any record keyed by input
// refs). The load-bearing rule is abstention: anything the IR marks
// opaque, and any value the interpreter cannot concretely trace
// (dependency results, unresolved references, method calls), evaluates
// to `unknown` — never a guess. Predicates compose under Kleene
// three-valued logic, so one unknown conjunct makes the conjunction
// unknown rather than silently true or false.
//
// Consumers: the differential fuzzer (tools/differential) uses it to
// adjudicate extracted claims against executions; `suss corroborate`
// uses it as the oracle for generating claim-satisfying inputs.

import type { ComparisonOp, Predicate, ValueRef } from "./index.js";

type DispatchTable<T extends { type: string }, R> = {
  [K in T["type"]]: (variant: Extract<T, { type: K }>) => R;
};

function dispatchByType<T extends { type: string }, R>(
  table: DispatchTable<T, R>,
  value: T,
): R {
  const handler = (table as unknown as Record<string, (val: T) => R>)[
    value.type
  ];
  return handler(value);
}

/** Three-valued truth: definitely true / definitely false / abstain. */
export type Tri = "true" | "false" | "unknown";

export type EvalValue = { type: "known"; value: unknown } | { type: "unknown" };

const KNOWN = (value: unknown): EvalValue => ({ type: "known", value });
const UNKNOWN: EvalValue = { type: "unknown" };

/**
 * The concrete environment: values keyed by the summary's input
 * references (for a handler, the parameter names — e.g. `req`).
 */
export type InterpretEnv = Record<string, unknown>;

// ---------------------------------------------------------------------------
// ValueRef evaluation
// ---------------------------------------------------------------------------

function readProperty(base: EvalValue, property: string | number): EvalValue {
  if (base.type === "unknown") {
    return UNKNOWN;
  }
  const value = base.value;
  // Reading off null/undefined/primitives would throw or box in JS;
  // abstain rather than model those semantics.
  if (typeof value !== "object" || value === null) {
    return UNKNOWN;
  }
  return KNOWN((value as Record<string | number, unknown>)[property]);
}

export function evalValueRef(ref: ValueRef, env: InterpretEnv): EvalValue {
  const table: DispatchTable<ValueRef, EvalValue> = {
    input: (r) => {
      if (!Object.hasOwn(env, r.inputRef)) {
        return UNKNOWN;
      }
      let current = KNOWN(env[r.inputRef]);
      for (const segment of r.path) {
        current = readProperty(current, segment);
      }
      return current;
    },
    literal: (r) => KNOWN(r.value),
    derived: (r) => {
      const base = evalValueRef(r.from, env);
      const derivations: DispatchTable<(typeof r)["derivation"], EvalValue> = {
        propertyAccess: (d) => readProperty(base, d.property),
        destructured: (d) => readProperty(base, d.field),
        indexAccess: (d) => readProperty(base, d.index),
        // Method results and awaited values are runtime behavior the
        // static summary can't see through — abstain.
        methodCall: () => UNKNOWN,
        awaited: () => UNKNOWN,
      };
      return dispatchByType(derivations, r.derivation);
    },
    dependency: () => UNKNOWN,
    state: () => UNKNOWN,
    unresolved: () => UNKNOWN,
  };
  return dispatchByType(table, ref);
}

// ---------------------------------------------------------------------------
// Predicate evaluation (Kleene three-valued)
// ---------------------------------------------------------------------------

const negate = (tri: Tri): Tri => {
  if (tri === "unknown") {
    return "unknown";
  }
  return tri === "true" ? "false" : "true";
};

const fromBoolean = (value: boolean): Tri => (value ? "true" : "false");

const applyNegated = (tri: Tri, negated: boolean): Tri =>
  negated ? negate(tri) : tri;

export function triAnd(values: Tri[]): Tri {
  if (values.some((v) => v === "false")) {
    return "false";
  }
  if (values.some((v) => v === "unknown")) {
    return "unknown";
  }
  return "true";
}

export function triOr(values: Tri[]): Tri {
  if (values.some((v) => v === "true")) {
    return "true";
  }
  if (values.some((v) => v === "unknown")) {
    return "unknown";
  }
  return "false";
}

type Comparator = (left: unknown, right: unknown) => Tri;

function orderedComparison(
  compare: (a: number | string, b: number | string) => boolean,
): Comparator {
  return (left, right) => {
    // Ordered comparison across mixed types drags in JS coercion —
    // abstain unless both sides are the same primitive ordering type.
    if (typeof left === "number" && typeof right === "number") {
      return fromBoolean(compare(left, right));
    }
    if (typeof left === "string" && typeof right === "string") {
      return fromBoolean(compare(left, right));
    }
    return "unknown";
  };
}

const COMPARATORS: Record<ComparisonOp, Comparator> = {
  eq: (left, right) => fromBoolean(left === right),
  neq: (left, right) => fromBoolean(left !== right),
  gt: orderedComparison((a, b) => a > b),
  gte: orderedComparison((a, b) => a >= b),
  lt: orderedComparison((a, b) => a < b),
  lte: orderedComparison((a, b) => a <= b),
};

const TYPEOF_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "undefined",
  "symbol",
  "bigint",
  "function",
]);

export function evalPredicate(predicate: Predicate, env: InterpretEnv): Tri {
  const table: DispatchTable<Predicate, Tri> = {
    truthinessCheck: (p) => {
      const subject = evalValueRef(p.subject, env);
      if (subject.type === "unknown") {
        return "unknown";
      }
      return applyNegated(fromBoolean(Boolean(subject.value)), p.negated);
    },
    nullCheck: (p) => {
      const subject = evalValueRef(p.subject, env);
      if (subject.type === "unknown") {
        return "unknown";
      }
      return applyNegated(
        fromBoolean(subject.value === null || subject.value === undefined),
        p.negated,
      );
    },
    comparison: (p) => {
      const left = evalValueRef(p.left, env);
      const right = evalValueRef(p.right, env);
      if (left.type === "unknown" || right.type === "unknown") {
        return "unknown";
      }
      return COMPARATORS[p.op](left.value, right.value);
    },
    typeCheck: (p) => {
      if (!TYPEOF_TYPES.has(p.expectedType)) {
        // instanceof-style checks against class names — the concrete
        // request env can't witness prototype chains; abstain.
        return "unknown";
      }
      const subject = evalValueRef(p.subject, env);
      if (subject.type === "unknown") {
        return "unknown";
      }
      return fromBoolean(typeof subject.value === p.expectedType);
    },
    propertyExists: (p) => {
      const subject = evalValueRef(p.subject, env);
      if (subject.type === "unknown") {
        return "unknown";
      }
      if (typeof subject.value !== "object" || subject.value === null) {
        // `"k" in primitive` throws in JS; abstain.
        return "unknown";
      }
      return applyNegated(
        fromBoolean(p.property in (subject.value as Record<string, unknown>)),
        p.negated,
      );
    },
    compound: (p) => {
      const operands = p.operands.map((operand) => evalPredicate(operand, env));
      return p.op === "and" ? triAnd(operands) : triOr(operands);
    },
    negation: (p) => negate(evalPredicate(p.operand, env)),
    // A call's behavior isn't in the IR — abstain.
    call: () => "unknown",
    // The constitution: opaque means "we preserved source text and
    // declined to guess". The interpreter honors that.
    opaque: () => "unknown",
  };
  return dispatchByType(table, predicate);
}

/** Conjunction of a transition's conditions under Kleene logic. */
export function evalConditions(
  conditions: Predicate[],
  env: InterpretEnv,
): Tri {
  return triAnd(conditions.map((condition) => evalPredicate(condition, env)));
}

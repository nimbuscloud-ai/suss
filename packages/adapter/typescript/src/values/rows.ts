/**
 * What JavaScript's operators and the string, array and path helpers a
 * route path is usually built from do to an abstract value. A callee row
 * matches on the import origin, so a project function spelled `join`
 * does not match the `path` row.
 */

import {
  appended,
  concat,
  constant,
  equals,
  extended,
  fallback,
  isPresent,
  joined,
  joinedPath,
  literalOf,
  negated,
  operand,
  plus,
  type Row,
  readableFallback,
  text,
  truthOf,
  type Value,
} from "@suss/values";

const PATH_MODULES = ["path", "node:path", "path/posix", "node:path/posix"];

const operatorRows: Row[] = [
  {
    kind: "operator",
    operator: "+",
    arity: 2,
    apply: ([a, b]) => plus(operand(a), operand(b)),
  },
  {
    kind: "operator",
    operator: "===",
    arity: 2,
    apply: ([a, b]) => equals(operand(a), operand(b)),
  },
  {
    kind: "operator",
    operator: "==",
    arity: 2,
    apply: ([a, b]) => equals(operand(a), operand(b)),
  },
  {
    kind: "operator",
    operator: "!==",
    arity: 2,
    apply: ([a, b]) => negated(equals(operand(a), operand(b))),
  },
  {
    kind: "operator",
    operator: "!=",
    arity: 2,
    apply: ([a, b]) => negated(equals(operand(a), operand(b))),
  },
  {
    kind: "operator",
    operator: "!",
    arity: 1,
    apply: ([a]) => negated(operand(a)),
  },
  {
    kind: "operator",
    operator: "??",
    arity: 2,
    apply: ([a, b]) => readableFallback(operand(a), operand(b), isPresent),
  },
  {
    kind: "operator",
    operator: "||",
    arity: 2,
    apply: ([a, b]) => readableFallback(operand(a), operand(b), truthOf),
  },
  {
    kind: "operator",
    operator: "&&",
    arity: 2,
    apply: ([a, b]) =>
      fallback(operand(a), operand(b), (left) => {
        const truth = truthOf(left);
        return truth === null ? null : !truth;
      }),
  },
];

const stringRows: Row[] = [
  {
    kind: "method",
    method: "toString",
    on: "string",
    apply: () => ({ result: "receiver" }),
  },
  {
    kind: "method",
    method: "toString",
    on: "constant",
    apply: ({ receiver }) => ({ result: concat([operand(receiver)]) }),
  },
  {
    kind: "method",
    method: "concat",
    on: "string",
    apply: ({ receiver, args }) => ({
      result: concat([operand(receiver), ...args]),
    }),
  },
];

const sequenceRows: Row[] = ["sequence", "unbounded"].flatMap((on): Row[] => [
  {
    kind: "method",
    method: "push",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args }) => ({
      result: constant(0),
      receiver: appended(operand(receiver), args),
    }),
  },
  {
    kind: "method",
    method: "concat",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args, contentOf }) => ({
      result: args.reduce<Value>(
        (sequence, other) => extended(sequence, contentOf(other)),
        operand(receiver),
      ),
    }),
  },
  {
    kind: "method",
    method: "join",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args }) => ({
      result: joined(operand(receiver), args[0]),
    }),
  },
]);

// Each spells its argument as text, so a path segment keeps the name of
// the value it was built from.
const TEXT_FUNCTIONS = [
  "String",
  "encodeURIComponent",
  "encodeURI",
  "decodeURIComponent",
  "decodeURI",
];

// A literal goes through the function itself, since
// `encodeURIComponent("a/b")` is one segment, not two.
function recoded(name: string, literal: string): string {
  if (name === "encodeURIComponent") {
    return encodeURIComponent(literal);
  }
  if (name === "encodeURI") {
    return encodeURI(literal);
  }
  if (name === "decodeURIComponent") {
    return decodeURIComponent(literal);
  }
  if (name === "decodeURI") {
    return decodeURI(literal);
  }
  return literal;
}

function textOf(name: string, value: Value): Value {
  const literal = literalOf(value);
  if (literal === null) {
    return concat([value]);
  }
  try {
    return text(recoded(name, literal));
  } catch {
    return concat([value]);
  }
}

const calleeRows: Row[] = [
  ...TEXT_FUNCTIONS.map(
    (name): Row => ({
      kind: "callee",
      origin: { module: "global", name },
      apply: ({ args }) => ({ result: textOf(name, operand(args[0])) }),
    }),
  ),
  ...PATH_MODULES.map(
    (module): Row => ({
      kind: "callee",
      origin: { module, name: "join" },
      apply: ({ args }) => ({ result: joinedPath(args) }),
    }),
  ),
];

export const typescriptRows: readonly Row[] = [
  ...operatorRows,
  ...stringRows,
  ...sequenceRows,
  ...calleeRows,
];

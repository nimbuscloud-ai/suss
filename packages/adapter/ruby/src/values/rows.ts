/**
 * What Ruby's operators and the string, array, path and environment
 * methods a route path is usually built from do to an abstract value.
 * A callee row matches on the receiver's constant path, so a project
 * method spelled `join` does not match the `File` row.
 */

import {
  appended,
  concat,
  environmentRead,
  equals,
  extended,
  fallback,
  formatArguments,
  hole,
  joined,
  joinedPath,
  negated,
  operand,
  percentFormatted,
  plus,
  type Row,
  readableFallback,
  stripped,
  truthOf,
  type Value,
} from "@suss/values";

function orRow(operator: string): Row {
  return {
    kind: "operator",
    operator,
    arity: 2,
    apply: ([a, b]) => readableFallback(operand(a), operand(b), truthOf),
  };
}

function andRow(operator: string): Row {
  return {
    kind: "operator",
    operator,
    arity: 2,
    apply: ([a, b]) =>
      fallback(operand(a), operand(b), (left) => {
        const truth = truthOf(left);
        return truth === null ? null : !truth;
      }),
  };
}

function notRow(operator: string): Row {
  return {
    kind: "operator",
    operator,
    arity: 1,
    apply: ([a]) => negated(operand(a)),
  };
}

const operatorRows: Row[] = [
  {
    kind: "operator",
    operator: "+",
    arity: 2,
    apply: ([a, b]) => plus(operand(a), operand(b)),
  },
  {
    kind: "operator",
    operator: "<<",
    arity: 2,
    apply: ([a, b], contentOf) => shifted(contentOf(operand(a)), operand(b)),
  },
  {
    kind: "operator",
    operator: "%",
    arity: 2,
    apply: ([a, b], contentOf) =>
      percentFormatted(operand(a), formatArguments(contentOf(operand(b)))),
  },
  {
    kind: "operator",
    operator: "==",
    arity: 2,
    apply: ([a, b]) => equals(operand(a), operand(b)),
  },
  {
    kind: "operator",
    operator: "!=",
    arity: 2,
    apply: ([a, b]) => negated(equals(operand(a), operand(b))),
  },
  orRow("||"),
  orRow("or"),
  andRow("&&"),
  andRow("and"),
  notRow("!"),
  notRow("not"),
];

/** `a << b` appends to an array and concatenates onto a string. */
function shifted(receiver: Value, value: Value): Value {
  if (receiver.kind === "sequence" || receiver.kind === "unbounded") {
    return appended(receiver, [value]);
  }
  return plus(receiver, value);
}

function stripRow(method: string, side: "both" | "start" | "end"): Row {
  return {
    kind: "method",
    method,
    on: "string",
    apply: ({ receiver, args }) => ({
      result:
        args.length === 0 ? stripped(operand(receiver), side) : hole("value"),
    }),
  };
}

const stringRows: Row[] = [
  {
    kind: "method",
    method: "to_s",
    on: "any",
    apply: ({ receiver }) => ({ result: concat([operand(receiver)]) }),
  },
  {
    kind: "method",
    method: "freeze",
    on: "any",
    apply: () => ({ result: "receiver" }),
  },
  {
    kind: "method",
    method: "dup",
    on: "any",
    apply: () => ({ result: "receiver" }),
  },
  ...["concat", "<<"].map(
    (method): Row => ({
      kind: "method",
      method,
      on: "string",
      apply: ({ receiver, args }) => ({
        result: plus(operand(receiver), operand(args[0])),
      }),
    }),
  ),
  stripRow("strip", "both"),
  stripRow("lstrip", "start"),
  stripRow("rstrip", "end"),
  stripRow("chomp", "end"),
];

const sequenceRows: Row[] = ["sequence", "unbounded"].flatMap((on): Row[] => [
  {
    kind: "method",
    method: "join",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args }) => ({
      result: joined(operand(receiver), args[0]),
    }),
  },
  ...["push", "append", "<<"].map(
    (method): Row => ({
      kind: "method",
      method,
      on: on as "sequence" | "unbounded",
      apply: ({ receiver, args }) => ({
        result: "receiver",
        receiver: appended(operand(receiver), args),
      }),
    }),
  ),
  {
    kind: "method",
    method: "concat",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args, contentOf }) => ({
      result: "receiver",
      receiver: extended(operand(receiver), contentOf(operand(args[0]))),
    }),
  },
]);

const calleeRows: Row[] = [
  {
    kind: "callee",
    origin: { module: "File", name: "join" },
    apply: ({ args }) => ({ result: joinedPath(args) }),
  },
  {
    kind: "callee",
    origin: { module: "ENV", name: "fetch" },
    apply: ({ args }) => ({ result: environmentRead(args) }),
  },
  ...["format", "sprintf"].map(
    (name): Row => ({
      kind: "callee",
      origin: { module: "Kernel", name },
      apply: ({ args }) => ({
        result: percentFormatted(operand(args[0]), args.slice(1)),
      }),
    }),
  ),
  {
    kind: "callee",
    origin: { module: "Kernel", name: "String" },
    apply: ({ args }) => ({ result: concat([operand(args[0])]) }),
  },
];

export const rubyRows: readonly Row[] = [
  ...operatorRows,
  ...stringRows,
  ...sequenceRows,
  ...calleeRows,
];

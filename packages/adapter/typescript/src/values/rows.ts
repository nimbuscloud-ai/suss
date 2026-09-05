/**
 * What JavaScript's operators and the string, array and path helpers a
 * route path is usually built from do to an abstract value. A callee row
 * matches on the import origin, so a project function spelled `join`
 * does not match the `path` row.
 */

import { posix } from "node:path";

import {
  appended,
  concat,
  constant,
  equals,
  extended,
  fallback,
  force,
  hole,
  isPresent,
  joined,
  literalOf,
  negated,
  plus,
  type Row,
  text,
  truthOf,
  type Value,
} from "@suss/values";

const PATH_MODULES = ["path", "node:path", "path/posix", "node:path/posix"];

const operand = (value: Value | null | undefined): Value =>
  value ?? hole("value");

/**
 * `a ?? b` and `a || b` when one side is a hole: the other side, which
 * is how the resolution rules read a fallback. `process.env.X ?? "/v1"`
 * is then `/v1`, the one thing the source says about its shape.
 */
function readableFallback(
  a: Value,
  b: Value,
  takesLeft: (left: Value) => boolean | null,
): Value {
  const left = force(a);
  const right = force(b);
  if (left.kind === "hole") {
    return right;
  }
  if (right.kind === "hole") {
    return left;
  }
  return fallback(left, right, takesLeft);
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

const calleeRows: Row[] = [
  {
    kind: "callee",
    origin: { module: "global", name: "String" },
    apply: ({ args }) => ({ result: concat([operand(args[0])]) }),
  },
  ...PATH_MODULES.map(
    (module): Row => ({
      kind: "callee",
      origin: { module, name: "join" },
      apply: ({ args }) => ({ result: joinedPath(args) }),
    }),
  ),
];

/** `path.join` of literal segments is folded as the library would; otherwise they are joined with `/`. */
function joinedPath(args: readonly Value[]): Value {
  const forced = args.map(force);
  const literals = forced.map(literalOf);
  if (literals.every((literal) => literal !== null)) {
    return text(posix.join(...(literals as string[])));
  }
  return concat(
    forced.flatMap((arg, i) => (i === 0 ? [arg] : [text("/"), arg])),
  );
}

export const typescriptRows: readonly Row[] = [
  ...operatorRows,
  ...stringRows,
  ...sequenceRows,
  ...calleeRows,
];

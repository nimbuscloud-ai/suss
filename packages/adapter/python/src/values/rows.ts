/**
 * What Python's operators and the string, list, path and environment
 * helpers a route path is usually built from do to an abstract value.
 * A callee row matches on the import origin, so a project function
 * spelled `join` does not match the `os.path` row.
 */

import { readSpellingsOf } from "@suss/recognize";
import {
  appended,
  caseRows,
  concat,
  constant,
  environmentRead,
  equals,
  extended,
  fallback,
  formatArguments,
  hole,
  joined,
  joinedPath,
  literalOf,
  negated,
  operand,
  percentFormatted,
  plus,
  type Row,
  readableFallback,
  stripped,
  text,
  truthOf,
  type Value,
} from "@suss/values";

import { ENVIRONMENT } from "../stdlib/environment.js";

import type {
  ArgumentPosition,
  Chain,
  GetterMeaning,
  ReadMeaning,
} from "@suss/recognize";

const operatorRows: Row[] = [
  {
    kind: "operator",
    operator: "+",
    arity: 2,
    apply: ([a, b]) => plus(operand(a), operand(b)),
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
  {
    kind: "operator",
    operator: "is",
    arity: 2,
    apply: ([a, b]) => equals(operand(a), operand(b)),
  },
  {
    kind: "operator",
    operator: "is not",
    arity: 2,
    apply: ([a, b]) => negated(equals(operand(a), operand(b))),
  },
  {
    kind: "operator",
    operator: "not",
    arity: 1,
    apply: ([a]) => negated(operand(a)),
  },
  {
    kind: "operator",
    operator: "or",
    arity: 2,
    apply: ([a, b]) => readableFallback(operand(a), operand(b), truthOf),
  },
  {
    kind: "operator",
    operator: "and",
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
    method: "join",
    on: "string",
    apply: ({ receiver, args, contentOf }) => ({
      result: joined(contentOf(operand(args[0])), operand(receiver)),
    }),
  },
  {
    kind: "method",
    method: "format",
    on: "string",
    apply: ({ receiver, args }) => ({
      result: braceFormatted(operand(receiver), args),
    }),
  },
  {
    kind: "method",
    method: "strip",
    on: "string",
    apply: ({ receiver, args }) => ({
      result: args.length === 0 ? stripped(operand(receiver)) : hole("value"),
    }),
  },
  {
    kind: "method",
    method: "rstrip",
    on: "string",
    apply: ({ receiver, args }) => ({
      result:
        args.length === 0 ? stripped(operand(receiver), "end") : hole("value"),
    }),
  },
  {
    kind: "method",
    method: "lstrip",
    on: "string",
    apply: ({ receiver, args }) => ({
      result:
        args.length === 0
          ? stripped(operand(receiver), "start")
          : hole("value"),
    }),
  },
  ...caseRows("lower", "upper"),
];

const sequenceRows: Row[] = ["sequence", "unbounded"].flatMap((on): Row[] => [
  {
    kind: "method",
    method: "append",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args }) => ({
      result: constant(null),
      receiver: appended(operand(receiver), args),
    }),
  },
  {
    kind: "method",
    method: "extend",
    on: on as "sequence" | "unbounded",
    apply: ({ receiver, args, contentOf }) => ({
      result: constant(null),
      receiver: extended(operand(receiver), contentOf(operand(args[0]))),
    }),
  },
]);

const calleeRows: Row[] = [
  {
    kind: "callee",
    origin: { module: "builtins", name: "str" },
    apply: ({ args }) => ({ result: concat([operand(args[0])]) }),
  },
  {
    kind: "callee",
    origin: { module: "os.path", name: "join" },
    apply: ({ args }) => ({ result: joinedPath(args) }),
  },
  ...environmentRows(ENVIRONMENT.declared),
];

/**
 * A read of the environment through one of the chain's functions or
 * getters, `os.getenv("X", d)` and `os.environ.get("X", d)`, is its
 * fallback when it passes one, read at the getter's own positions.
 */
function environmentRows(chain: Chain<ReadMeaning>): Row[] {
  const spellings = readSpellingsOf(chain);
  const origins = [
    ...Object.entries(spellings.functions).map(([path, getter]) => {
      const dot = path.lastIndexOf(".");
      return {
        origin: { module: path.slice(0, dot), name: path.slice(dot + 1) },
        getter,
      };
    }),
    ...Object.entries(spellings.getters).flatMap(([name, getter]) =>
      spellings.paths.map((module) => ({ origin: { module, name }, getter })),
    ),
  ];
  return origins.map(({ origin, getter }) => ({
    kind: "callee",
    origin,
    apply: ({ args }) => ({
      result: environmentRead(getterArguments(args, getter)),
    }),
  }));
}

/** The key a getter call passes, then its fallback, as `environmentRead` takes them. */
function getterArguments(
  args: readonly Value[],
  getter: GetterMeaning,
): Value[] {
  const key = args[getter.key.at];
  const fallback = args[fallbackPosition(getter)];
  if (key === undefined) {
    return [];
  }
  return fallback === undefined ? [key] : [key, fallback];
}

/** The position a getter takes its fallback at, or -1 when it takes none by position. */
function fallbackPosition(getter: GetterMeaning): number {
  const picks = getter.fallback === undefined ? [] : [getter.fallback].flat();
  const pick = picks.find((one): one is ArgumentPosition => !("block" in one));
  return pick?.at ?? -1;
}

const BRACE_PLACEHOLDER = /\{([^{}]*)\}/g;

/** `"/{}/x".format(a)` and `"/{name}".format(name=a)`: each placeholder takes the next positional argument. */
function braceFormatted(receiver: Value, args: readonly Value[]): Value {
  const template = literalOf(receiver);
  if (template === null) {
    return hole("value");
  }
  const parts: Value[] = [];
  let last = 0;
  let position = 0;
  for (const match of template.matchAll(BRACE_PLACEHOLDER)) {
    parts.push(text(template.slice(last, match.index)));
    const argument = args[position];
    const placeholder = match[1] ?? "";
    parts.push(
      argument === undefined
        ? hole(
            placeholder === ""
              ? "value"
              : (placeholder.split(/[!:]/)[0] ?? "value"),
          )
        : concat([argument]),
    );
    position += 1;
    last = match.index + match[0].length;
  }
  parts.push(text(template.slice(last)));
  return concat(parts);
}

export const pythonRows: readonly Row[] = [
  ...operatorRows,
  ...stringRows,
  ...sequenceRows,
  ...calleeRows,
];

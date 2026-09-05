/**
 * A tiny language for the engine's own tests: each node is a plain
 * object whose `shape` is the lowered form, with parent links filled in
 * by `module()`. The rows cover `+`, `===`, `!`, `push`, `join` and
 * `concat`, which is enough to exercise every path through the engine.
 */

import {
  type Element,
  type Expression,
  expressionBodyOf,
  type Field,
  type FunctionShape,
  type Lowering,
  type Parameter,
  parameter,
  type Row,
  type Site,
  type Statement,
  statementsOf,
} from "./language.js";
import {
  appended,
  equals,
  extended,
  joined,
  negated,
  plus,
} from "./operations.js";
import { concat, constant, hole, text } from "./value.js";

export interface TestNode {
  shape: Expression<TestNode> | Statement<TestNode>;
  parent: TestNode | null;
  /** For a function node: its parameters and body. */
  fn?: FunctionShape<TestNode>;
  /** For a module: its statements. */
  moduleBody?: TestNode[];
  /** Set on a name node to say what it resolves to elsewhere. */
  writtenTo?: TestNode;
  /** Set on a call node to say which function it calls. */
  calls?: TestNode;
  mutatedNames?: string[];
  freeNames?: string[];
}

function node(
  shape: Expression<TestNode> | Statement<TestNode>,
  extra: Partial<TestNode> = {},
): TestNode {
  return { shape, parent: null, ...extra };
}

export const lit = (value: string | number | boolean | null): TestNode =>
  node({ kind: "literal", value });
export const name = (text: string, writtenTo?: TestNode): TestNode =>
  node({ kind: "name", text }, writtenTo === undefined ? {} : { writtenTo });
export const member = (object: TestNode, field: string): TestNode =>
  node({ kind: "member", object, name: field });
export const element = (object: TestNode, index: TestNode): TestNode =>
  node({ kind: "element", object, index });
export const array = (
  ...items: (TestNode | { spread: TestNode })[]
): TestNode =>
  node({
    kind: "array",
    items: items.map(
      (item): Element<TestNode> =>
        "spread" in item
          ? { kind: "spread", node: item.spread }
          : { kind: "value", node: item },
    ),
  });
export const record = (
  fields: Record<string, TestNode> | { spread: TestNode }[],
): TestNode =>
  node({
    kind: "record",
    fields: Array.isArray(fields)
      ? fields.map(
          (entry): Field<TestNode> => ({
            kind: "spread",
            node: entry.spread,
          }),
        )
      : Object.entries(fields).map(
          ([key, value]): Field<TestNode> => ({
            kind: "field",
            name: key,
            value,
          }),
        ),
  });
export const template = (...parts: (string | TestNode)[]): TestNode =>
  node({
    kind: "template",
    parts: parts.map((part) =>
      typeof part === "string" ? { text: part } : { expression: part },
    ),
  });
export const op = (operator: string, ...operands: TestNode[]): TestNode =>
  node({ kind: "operator", operator, operands });
export const cond = (
  condition: TestNode,
  whenTrue: TestNode,
  whenFalse: TestNode,
): TestNode => node({ kind: "conditional", condition, whenTrue, whenFalse });
export const computedRecord = (
  entries: [TestNode, TestNode][],
  spread?: TestNode,
): TestNode =>
  node({
    kind: "record",
    fields: [
      ...entries.map(
        ([key, value]): Field<TestNode> => ({
          kind: "computed",
          name: key,
          value,
        }),
      ),
      ...(spread === undefined
        ? []
        : [{ kind: "spread", node: spread } as Field<TestNode>]),
    ],
  });
export const call = (
  receiver: TestNode | null,
  method: string | null,
  args: (
    | TestNode
    | { spread: TestNode }
    | { named: string; node: TestNode }
  )[] = [],
  extra: Partial<TestNode> & {
    origin?: { module: string; name: string };
    constructs?: boolean;
  } = {},
): TestNode => {
  const { origin, constructs, ...rest } = extra;
  return node(
    {
      kind: "call",
      callee: {
        receiver,
        name: method,
        origin: () => origin ?? null,
      },
      args: args.map((arg): Element<TestNode> => {
        if ("spread" in arg) {
          return { kind: "spread", node: arg.spread };
        }
        if ("named" in arg) {
          return { kind: "named", name: arg.named, node: arg.node };
        }
        return { kind: "value", node: arg };
      }),
      constructs: constructs ?? false,
    },
    rest,
  );
};
export const fn = (
  parameterList: (string | Parameter<TestNode>)[],
  body: TestNode[] | TestNode,
  extra: Partial<TestNode> = {},
): TestNode => {
  const parameters = parameterList.map((entry) =>
    typeof entry === "string" ? parameter<TestNode>(entry) : entry,
  );
  const shape: FunctionShape<TestNode> = Array.isArray(body)
    ? { parameters, body }
    : { parameters, body: { expression: body } };
  return node(
    { kind: "function", node: null as unknown as TestNode },
    {
      fn: shape,
      ...extra,
    },
  );
};
export const opaque = (): TestNode => node({ kind: "opaque" });

export const declare = (bindings: Record<string, TestNode | null>): TestNode =>
  node({
    kind: "declare",
    bindings: Object.entries(bindings).map(([key, value]) => ({
      name: key,
      value,
    })),
  });
export const assign = (
  target: TestNode,
  value: TestNode,
  operator: string | null = null,
): TestNode => node({ kind: "assign", target, operator, value });
export const expr = (value: TestNode): TestNode =>
  node({ kind: "expression", value });
export const branch = (
  condition: TestNode | null,
  ...arms: TestNode[][]
): TestNode => node({ kind: "branch", condition, arms });
export const loop = (body: TestNode[]): TestNode =>
  node({ kind: "loop", body });
export const ret = (value: TestNode | null): TestNode =>
  node({ kind: "return", value });
export const block = (body: TestNode[]): TestNode =>
  node({ kind: "block", body });

/** Links every node to its parent and returns the module node. */
export function module(body: TestNode[]): TestNode {
  const root = node({ kind: "opaque" }, { moduleBody: body });
  for (const stmt of body) {
    link(stmt, root);
  }
  return root;
}

function link(child: TestNode, parent: TestNode): void {
  child.parent = parent;
  for (const grandchild of childrenOf(child)) {
    link(grandchild, child);
  }
}

function childrenOf(n: TestNode): TestNode[] {
  if (n.fn !== undefined) {
    const defaults = n.fn.parameters.flatMap((entry) =>
      entry.default === null ? [] : [entry.default],
    );
    const returned = expressionBodyOf(n.fn.body);
    return [
      ...defaults,
      ...(returned === null ? statementsOf(n.fn.body) : [returned]),
    ];
  }
  const shape = n.shape;
  const table: Record<string, () => TestNode[]> = {
    literal: () => [],
    name: () => [],
    opaque: () => [],
    function: () => [],
    template: () =>
      shape.kind === "template"
        ? shape.parts.flatMap((part) =>
            "expression" in part ? [part.expression] : [],
          )
        : [],
    member: () => (shape.kind === "member" ? [shape.object] : []),
    element: () =>
      shape.kind === "element" ? [shape.object, shape.index] : [],
    array: () => (shape.kind === "array" ? shape.items.map((i) => i.node) : []),
    record: () =>
      shape.kind === "record"
        ? shape.fields.flatMap((f) =>
            f.kind === "spread"
              ? [f.node]
              : f.kind === "field"
                ? [f.value]
                : [f.name, f.value],
          )
        : [],
    call: () =>
      shape.kind === "call"
        ? [
            ...(shape.callee.receiver === null ? [] : [shape.callee.receiver]),
            ...shape.args.map((a) => a.node),
          ]
        : [],
    operator: () => (shape.kind === "operator" ? [...shape.operands] : []),
    conditional: () =>
      shape.kind === "conditional"
        ? [shape.condition, shape.whenTrue, shape.whenFalse]
        : [],
    declare: () =>
      shape.kind === "declare"
        ? shape.bindings.flatMap((b) => (b.value === null ? [] : [b.value]))
        : [],
    assign: () => (shape.kind === "assign" ? [shape.target, shape.value] : []),
    expression: () => (shape.kind === "expression" ? [shape.value] : []),
    branch: () =>
      shape.kind === "branch"
        ? [
            ...(shape.condition === null ? [] : [shape.condition]),
            ...shape.arms.flat(),
          ]
        : [],
    loop: () => (shape.kind === "loop" ? [...shape.body] : []),
    return: () =>
      shape.kind === "return" && shape.value !== null ? [shape.value] : [],
    block: () => (shape.kind === "block" ? [...shape.body] : []),
  };
  return table[shape.kind]?.() ?? [];
}

function isStatement(n: TestNode): boolean {
  return [
    "declare",
    "assign",
    "expression",
    "branch",
    "loop",
    "return",
    "block",
  ].includes(n.shape.kind);
}

function isRoot(n: TestNode): boolean {
  return n.fn !== undefined || n.moduleBody !== undefined;
}

function siteOf(n: TestNode): Site<TestNode> | null {
  const path: TestNode[] = [];
  let current = n;
  while (current.parent !== null) {
    const parent = current.parent;
    if (isStatement(current) || isRoot(parent)) {
      path.unshift(current);
    }
    if (isRoot(parent)) {
      return { root: parent, path };
    }
    current = parent;
  }
  return null;
}

const rows: Row[] = [
  {
    kind: "operator",
    operator: "+",
    arity: 2,
    apply: ([a, b]) => plus(a ?? hole("value"), b ?? hole("value")),
  },
  {
    kind: "operator",
    operator: "===",
    arity: 2,
    apply: ([a, b]) => equals(a ?? hole("value"), b ?? hole("value")),
  },
  {
    kind: "operator",
    operator: "!",
    arity: 1,
    apply: ([a]) => negated(a ?? hole("value")),
  },
  {
    kind: "method",
    method: "push",
    on: "sequence",
    apply: ({ receiver, args }) => ({
      result: constant(0),
      receiver: appended(receiver ?? hole("value"), args),
    }),
  },
  {
    kind: "method",
    method: "push",
    on: "unbounded",
    apply: ({ receiver, args }) => ({
      result: constant(0),
      receiver: appended(receiver ?? hole("value"), args),
    }),
  },
  {
    kind: "method",
    method: "join",
    on: "sequence",
    apply: ({ receiver, args }) => ({
      result: joined(receiver ?? hole("value"), args[0]),
    }),
  },
  {
    kind: "method",
    method: "join",
    on: "unbounded",
    apply: ({ receiver, args }) => ({
      result: joined(receiver ?? hole("value"), args[0]),
    }),
  },
  {
    kind: "method",
    method: "concat",
    on: "sequence",
    apply: ({ receiver, args, contentOf }) => ({
      result: args.reduce(
        (sequence, other) => extended(sequence, contentOf(other)),
        receiver ?? hole("value"),
      ),
    }),
  },
  {
    kind: "method",
    method: "concat",
    on: "string",
    apply: ({ receiver, args }) => ({
      result: concat([receiver ?? text(""), ...args]),
    }),
  },
  {
    kind: "method",
    method: "sort",
    on: "any",
    apply: () => ({ result: "receiver" }),
  },
  {
    kind: "callee",
    origin: { module: "path", name: "join" },
    apply: ({ args }) => ({
      result: concat(
        args.flatMap((arg, i) => (i === 0 ? [arg] : [text("/"), arg])),
      ),
    }),
  },
  {
    kind: "callee",
    origin: { module: "lib", name: "same" },
    apply: () => ({ result: "receiver" }),
  },
  {
    kind: "callee",
    origin: { module: "lib", name: "Box" },
    constructs: true,
    apply: ({ args }) => ({ result: args[0] ?? hole("value") }),
  },
];

export const testLowering: Lowering<TestNode> = {
  expression: (n) => n.shape as Expression<TestNode>,
  statement: (n) => n.shape as Statement<TestNode>,
  siteOf,
  functionOf: (n) => {
    if (n.fn !== undefined) {
      return n.fn;
    }
    if (n.moduleBody !== undefined) {
      return { parameters: [], body: n.moduleBody };
    }
    return null;
  },
  writtenTo: (n) => n.writtenTo ?? null,
  callable: (n) => n.calls ?? null,
  mutatedInNestedFunction: (root, text) =>
    root.mutatedNames?.includes(text) ?? false,
  freeNamesOf: (f) => f.freeNames ?? [],
  holeNameOf: (n) => {
    if (n.shape.kind === "name") {
      return n.shape.text;
    }
    if (n.shape.kind === "member") {
      return n.shape.name;
    }
    return "param";
  },
  rows,
};

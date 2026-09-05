/**
 * The Python side of the value evaluator: each tree-sitter node lowered
 * to one of the engine's expression or statement shapes, on demand.
 *
 * A root is the module or a function; a class body is a root for the
 * methods inside it and opaque to the module around it. The engine
 * keys nodes by `node.id`, because tree-sitter hands back a fresh
 * wrapper on every read. The two cross-file questions, which
 * expression a name was written as and which function a callee is, go
 * to the resolution facts through `EvaluationContext`.
 */

import { children, field, stringLiteralValue } from "../ast.js";
import { parameterList } from "../facts/values.js";

import type {
  Element,
  Expression,
  Field,
  FunctionShape,
  Lowering,
  Origin,
  Row,
  Site,
  Statement,
} from "@suss/values";
import type { PyNode } from "../parser.js";

export interface EvaluationContext {
  /** The expression a name or call resolves to through the facts, or null. */
  writtenTo(node: PyNode): PyNode | null;
  /** The function definition a call's callee resolves to, or null. */
  callable(call: PyNode): PyNode | null;
}

export interface LoweringOptions {
  readonly context: EvaluationContext | null;
  /** The module and name a callee was imported as, read off the file's scopes. */
  readonly originOf: (callee: PyNode) => Origin | null;
  readonly rows: readonly Row[];
}

const ROOT_TYPES = new Set(["module", "function_definition", "lambda"]);

const LITERAL_TYPES: Record<string, (node: PyNode) => Expression<PyNode>> = {
  integer: (node) => ({ kind: "literal", value: Number(node.text) }),
  float: (node) => ({ kind: "literal", value: Number(node.text) }),
  true: () => ({ kind: "literal", value: true }),
  false: () => ({ kind: "literal", value: false }),
  none: () => ({ kind: "literal", value: null }),
};

/** The method rows that write to their receiver rather than read it. */
const WRITING_ROWS = new Set(["append", "extend"]);

/**
 * A method the rows model as a read leaves its receiver as it was. Any
 * other method call on a name may write to it, so a nested call widens
 * the name.
 */
function readingMethodsOf(rows: readonly Row[]): Set<string> {
  return new Set(
    rows.flatMap((row) =>
      row.kind === "method" && !WRITING_ROWS.has(row.method)
        ? [row.method]
        : [],
    ),
  );
}

export function pythonLowering(options: LoweringOptions): Lowering<PyNode> {
  const { context, originOf, rows } = options;
  const readingMethods = readingMethodsOf(rows);
  const mutatedByRoot = new Map<number, Set<string>>();

  return {
    idOf: (node) => node.id,
    expression: (node) => expressionOf(node, originOf),
    statement: statementOf,
    siteOf,
    functionOf,
    writtenTo: (node) => (context === null ? null : context.writtenTo(node)),
    callable: (node) => {
      if (context === null || hasKeywordArguments(node)) {
        return null;
      }
      return context.callable(node);
    },
    mutatedInNestedFunction: (root, name) => {
      let mutated = mutatedByRoot.get(root.id);
      if (mutated === undefined) {
        mutated = namesMutatedInNestedFunctions(root, readingMethods);
        mutatedByRoot.set(root.id, mutated);
      }
      return mutated.has(name);
    },
    freeNamesOf,
    holeNameOf: placeholderName,
    rows,
  };
}

/** The name a hole takes for an expression nothing could read. */
export function placeholderName(node: PyNode): string {
  const peeled = peelValue(node);
  if (peeled.type === "identifier") {
    return peeled.text;
  }
  if (peeled.type === "attribute") {
    return field(peeled, "attribute")?.text ?? "param";
  }
  return "param";
}

/** Parentheses and `await` do not change what a value is. */
export function peelValue(node: PyNode): PyNode {
  const wraps =
    node.type === "parenthesized_expression" || node.type === "await";
  const inner = wraps ? children(node)[0] : undefined;
  return inner === undefined ? node : peelValue(inner);
}

const OPAQUE = { kind: "opaque" } as const;

/** Build from a node's named fields, or fall back when the parse left one out. */
function fromFields<T>(
  node: PyNode,
  names: readonly string[],
  fallback: T,
  build: (...parts: PyNode[]) => T,
): T {
  const found = names.map((name) => field(node, name));
  if (found.some((part) => part === null)) {
    return fallback;
  }
  return build(...(found as PyNode[]));
}

function expressionOf(
  node: PyNode,
  originOf: (callee: PyNode) => Origin | null,
): Expression<PyNode> {
  const peeled = peelValue(node);
  const literal = LITERAL_TYPES[peeled.type];
  if (literal !== undefined) {
    return literal(peeled);
  }
  if (peeled.type === "string") {
    return stringExpression(peeled);
  }
  if (peeled.type === "concatenated_string") {
    return {
      kind: "template",
      parts: children(peeled).map((part) => ({ expression: part })),
    };
  }
  if (peeled.type === "identifier") {
    return { kind: "name", text: peeled.text };
  }
  if (peeled.type === "attribute") {
    return fromFields<Expression<PyNode>>(
      peeled,
      ["object", "attribute"],
      OPAQUE,
      (object, name) => ({
        kind: "member",
        object,
        name: name.text,
      }),
    );
  }
  if (peeled.type === "subscript") {
    const object = field(peeled, "value");
    const index = field(peeled, "subscript");
    if (object === null || index === null || index.type === "slice") {
      return { kind: "opaque" };
    }
    return { kind: "element", object, index };
  }
  if (
    peeled.type === "list" ||
    peeled.type === "tuple" ||
    peeled.type === "expression_list"
  ) {
    return { kind: "array", items: children(peeled).map(elementOf) };
  }
  if (peeled.type === "dictionary") {
    return { kind: "record", fields: children(peeled).flatMap(fieldOf) };
  }
  if (peeled.type === "call") {
    return callExpression(peeled, originOf);
  }
  if (peeled.type === "binary_operator" || peeled.type === "boolean_operator") {
    return fromFields<Expression<PyNode>>(
      peeled,
      ["left", "operator", "right"],
      OPAQUE,
      (left, operator, right) => ({
        kind: "operator",
        operator: operator.text,
        operands: [left, right],
      }),
    );
  }
  if (peeled.type === "comparison_operator") {
    return comparisonExpression(peeled);
  }
  if (peeled.type === "not_operator") {
    return fromFields<Expression<PyNode>>(
      peeled,
      ["argument"],
      OPAQUE,
      (argument) => ({
        kind: "operator",
        operator: "not",
        operands: [argument],
      }),
    );
  }
  if (peeled.type === "conditional_expression") {
    const [whenTrue, condition, whenFalse] = children(peeled);
    if (
      whenTrue === undefined ||
      condition === undefined ||
      whenFalse === undefined
    ) {
      return { kind: "opaque" };
    }
    return { kind: "conditional", condition, whenTrue, whenFalse };
  }
  if (peeled.type === "lambda") {
    return { kind: "function", node: peeled };
  }
  return { kind: "opaque" };
}

/** A plain string is a literal; an f-string is a template over its interpolations. */
function stringExpression(node: PyNode): Expression<PyNode> {
  const plain = stringLiteralValue(node);
  if (plain !== null) {
    return { kind: "literal", value: plain };
  }
  const parts: ({ text: string } | { expression: PyNode })[] = [];
  for (const child of children(node)) {
    if (child.type === "string_content") {
      parts.push({ text: child.text });
      continue;
    }
    if (child.type === "interpolation") {
      const expression = field(child, "expression") ?? children(child)[0];
      if (expression !== undefined) {
        parts.push({ expression });
      }
    }
  }
  return { kind: "template", parts };
}

/** `a == b` lowers to the operator; a chain like `a < b < c` is left opaque. */
function comparisonExpression(node: PyNode): Expression<PyNode> {
  const operands = children(node);
  const operators = node.children.filter(
    (child): child is PyNode => child !== null && !child.isNamed,
  );
  const operator = operators[0];
  if (
    operands.length !== 2 ||
    operators.length !== 1 ||
    operator === undefined
  ) {
    return { kind: "opaque" };
  }
  return {
    kind: "operator",
    operator: operator.text,
    operands: [operands[0] as PyNode, operands[1] as PyNode],
  };
}

function callExpression(
  node: PyNode,
  originOf: (callee: PyNode) => Origin | null,
): Expression<PyNode> {
  return fromFields<Expression<PyNode>>(
    node,
    ["function", "arguments"],
    OPAQUE,
    (callee, argumentList) => {
      const peeledCallee = peelValue(callee);
      const args =
        argumentList.type === "argument_list"
          ? positionalArguments(argumentList).map(elementOf)
          : [];
      const isMethod = peeledCallee.type === "attribute";
      return {
        kind: "call",
        callee: {
          receiver: isMethod ? field(peeledCallee, "object") : null,
          name: calleeName(peeledCallee),
          origin: () => originOf(peeledCallee),
        },
        args,
        constructs: false,
      };
    },
  );
}

function calleeName(callee: PyNode): string | null {
  if (callee.type === "identifier") {
    return callee.text;
  }
  if (callee.type === "attribute") {
    return field(callee, "attribute")?.text ?? null;
  }
  return null;
}

/** The arguments at a position. A keyword argument has no position, so it is left out. */
function positionalArguments(argumentList: PyNode): PyNode[] {
  return children(argumentList).filter(
    (argument) =>
      argument.type !== "keyword_argument" &&
      argument.type !== "dictionary_splat",
  );
}

function hasKeywordArguments(call: PyNode): boolean {
  const argumentList = field(call, "arguments");
  if (argumentList === null) {
    return false;
  }
  return children(argumentList).some(
    (argument) =>
      argument.type === "keyword_argument" ||
      argument.type === "dictionary_splat",
  );
}

function elementOf(node: PyNode): Element<PyNode> {
  if (node.type === "list_splat") {
    const inner = children(node)[0];
    return inner === undefined
      ? { kind: "value", node }
      : { kind: "spread", node: inner };
  }
  return { kind: "value", node };
}

function fieldOf(node: PyNode): Field<PyNode>[] {
  if (node.type === "dictionary_splat") {
    const inner = children(node)[0];
    return inner === undefined ? [] : [{ kind: "spread", node: inner }];
  }
  if (node.type !== "pair") {
    return [];
  }
  return fromFields(node, ["key", "value"], [], (key, value) => {
    const name = stringLiteralValue(key);
    return name === null
      ? [{ kind: "computed", name: key, value }]
      : [{ kind: "field", name, value }];
  });
}

const STATEMENT_TYPES: Record<string, (node: PyNode) => Statement<PyNode>> = {
  expression_statement: expressionStatement,
  if_statement: ifStatement,
  elif_clause: ifStatement,
  for_statement: loopStatement,
  while_statement: loopStatement,
  return_statement: (node) => ({
    kind: "return",
    value: children(node)[0] ?? null,
  }),
  try_statement: (node) => ({
    kind: "block",
    body: [
      ...blockStatements(field(node, "body")),
      ...children(node).flatMap((clause) =>
        clause.type === "finally_clause"
          ? blockStatements(children(clause)[0] ?? null)
          : [],
      ),
    ],
  }),
  with_statement: (node) => ({
    kind: "block",
    body: blockStatements(field(node, "body")),
  }),
};

function statementOf(node: PyNode): Statement<PyNode> {
  const lower = STATEMENT_TYPES[node.type];
  return lower === undefined ? { kind: "opaque" } : lower(node);
}

function expressionStatement(node: PyNode): Statement<PyNode> {
  const inner = children(node)[0];
  if (inner === undefined) {
    return { kind: "opaque" };
  }
  if (inner.type === "assignment") {
    return assignment(inner, null);
  }
  if (inner.type === "augmented_assignment") {
    const operator = field(inner, "operator");
    return assignment(
      inner,
      operator === null ? null : operator.text.slice(0, -1),
    );
  }
  return { kind: "expression", value: inner };
}

/** `a = b` is an assignment; `a, b = c` declares each name with nothing readable behind it. */
function assignment(node: PyNode, operator: string | null): Statement<PyNode> {
  return fromFields<Statement<PyNode>>(
    node,
    ["left", "right"],
    OPAQUE,
    (target, value) => {
      if (target.type === "pattern_list" || target.type === "tuple_pattern") {
        return {
          kind: "declare",
          bindings: patternNames(target).map((name) => ({ name, value: null })),
        };
      }
      return { kind: "assign", target, operator, value };
    },
  );
}

function patternNames(pattern: PyNode): string[] {
  return children(pattern).flatMap((child) =>
    child.type === "identifier" ? [child.text] : patternNames(child),
  );
}

/** `if`/`elif`/`else`: the other arm is the next clause, lowered as a branch of its own. */
function ifStatement(node: PyNode): Statement<PyNode> {
  return fromFields<Statement<PyNode>>(
    node,
    ["condition", "consequence"],
    OPAQUE,
    (condition, consequence) => ({
      kind: "branch",
      condition,
      arms: [blockStatements(consequence), otherArm(node)],
    }),
  );
}

/** The clause after this one within the `if` statement, or nothing when it was the last. */
function otherArm(clause: PyNode): PyNode[] {
  const statement = clause.type === "if_statement" ? clause : clause.parent;
  const clauses = statement === null ? [] : children(statement);
  const next = clauses
    .slice(clauses.findIndex((child) => child.id === clause.id) + 1)
    .find(
      (child) => child.type === "elif_clause" || child.type === "else_clause",
    );
  if (next === undefined) {
    return [];
  }
  return next.type === "elif_clause"
    ? [next]
    : blockStatements(field(next, "body"));
}

function loopStatement(node: PyNode): Statement<PyNode> {
  return { kind: "loop", body: blockStatements(field(node, "body")) };
}

function blockStatements(block: PyNode | null): PyNode[] {
  return block === null ? [] : children(block);
}

function isRoot(node: PyNode): boolean {
  return ROOT_TYPES.has(node.type);
}

/**
 * Whether `node` is one of the statements a branch, loop or block
 * lowers to: a child of the module or of a block, or an `elif` clause,
 * which the `if` before it lists as its other arm.
 */
function isPathStatement(node: PyNode, parent: PyNode): boolean {
  return (
    parent.type === "module" ||
    parent.type === "block" ||
    node.type === "elif_clause"
  );
}

function siteOf(node: PyNode): Site<PyNode> | null {
  const path: PyNode[] = [];
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (parent === null) {
      return null;
    }
    if (isPathStatement(current, parent)) {
      path.unshift(current);
    }
    if (isRoot(parent)) {
      return { root: parent, path };
    }
    current = parent;
  }
}

/**
 * A method's first parameter is its receiver, which no call passes at a
 * position, so it is left out and reads of it come out as holes.
 */
function functionOf(node: PyNode): FunctionShape<PyNode> | null {
  if (node.type === "module") {
    return { parameters: [], body: children(node) };
  }
  if (node.type === "lambda") {
    const body = field(node, "body");
    if (body === null) {
      return null;
    }
    return { parameters: parameterList(node), body: { expression: body } };
  }
  if (node.type !== "function_definition") {
    return null;
  }
  const parameters = parameterList(node);
  return {
    parameters: isMethod(node) ? parameters.slice(1) : parameters,
    body: blockStatements(field(node, "body")),
  };
}

function isMethod(fn: PyNode): boolean {
  const owner =
    fn.parent?.type === "decorated_definition" ? fn.parent.parent : fn.parent;
  return owner?.type === "block" && owner.parent?.type === "class_definition";
}

function namesMutatedInNestedFunctions(
  root: PyNode,
  readingMethods: ReadonlySet<string>,
): Set<string> {
  const mutated = new Set<string>();
  const visit = (node: PyNode, nested: boolean): void => {
    const name = writtenNameOf(node, readingMethods);
    if (nested && name !== null) {
      mutated.add(name);
    }
    for (const child of children(node)) {
      visit(child, nested || isRoot(child));
    }
  };
  for (const child of children(root)) {
    visit(child, isRoot(child));
  }
  return mutated;
}

function writtenNameOf(
  node: PyNode,
  readingMethods: ReadonlySet<string>,
): string | null {
  if (node.type === "assignment" || node.type === "augmented_assignment") {
    const target = field(node, "left");
    return target?.type === "identifier" ? target.text : null;
  }
  if (node.type === "call") {
    const callee = field(node, "function");
    if (callee?.type !== "attribute") {
      return null;
    }
    const receiver = field(callee, "object");
    const method = field(callee, "attribute");
    if (
      receiver?.type === "identifier" &&
      method !== null &&
      !readingMethods.has(method.text)
    ) {
      return receiver.text;
    }
  }
  return null;
}

const DECLARING_PARENTS = new Set([
  "parameters",
  "default_parameter",
  "typed_parameter",
  "typed_default_parameter",
  "lambda_parameters",
  "pattern_list",
  "tuple_pattern",
  "for_statement",
]);

function freeNamesOf(fn: PyNode): readonly string[] {
  const declared = new Set<string>();
  const read = new Set<string>();
  const visit = (node: PyNode): void => {
    for (const child of children(node)) {
      if (child.type !== "identifier") {
        visit(child);
        continue;
      }
      if (
        node.type === "attribute" &&
        field(node, "attribute")?.id === child.id
      ) {
        continue;
      }
      if (
        node.type === "keyword_argument" &&
        field(node, "name")?.id === child.id
      ) {
        continue;
      }
      if (
        DECLARING_PARENTS.has(node.type) ||
        (node.type === "assignment" && field(node, "left")?.id === child.id)
      ) {
        declared.add(child.text);
        continue;
      }
      read.add(child.text);
    }
  };
  visit(fn);
  return [...read].filter((name) => !declared.has(name));
}

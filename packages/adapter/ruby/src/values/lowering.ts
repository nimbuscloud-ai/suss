/**
 * The Ruby side of the value evaluator: each tree-sitter node lowered
 * to one of the engine's expression or statement shapes, on demand.
 *
 * A root is the file, a method, a lambda, a class body, or the block
 * handed to a call. A block is a root of its own so that a route
 * written inside `namespace :api do ... end` still reads a name the
 * `draw` block bound above it, through the enclosing-scope walk. The
 * block inside a `-> { }` literal belongs to the lambda and is not a
 * root itself. A method's last expression is its return, so the
 * statement lowering marks a tail-position expression as one. The
 * engine keys nodes by `node.id`, because tree-sitter hands back a
 * fresh wrapper on every read.
 */

import {
  bodyStatements,
  field,
  hashKeySymbolName,
  stringLiteralValue,
  symbolValue,
} from "../ast.js";

import type {
  Element,
  Expression,
  Field,
  FunctionShape,
  Lowering,
  Origin,
  Parameter,
  Row,
  Site,
  Statement,
} from "@suss/values";
import type { RbNode } from "../parser.js";

export interface EvaluationContext {
  /** The expression a name or call resolves to through the facts, or null. */
  writtenTo(node: RbNode): RbNode | null;
  /** The method definition a call's callee resolves to, or null. */
  callable(call: RbNode): RbNode | null;
}

export interface LoweringOptions {
  readonly context: EvaluationContext | null;
  readonly rows: readonly Row[];
}

/** The named children that are code; tree-sitter lists a comment as a named child too. */
function named(node: RbNode): RbNode[] {
  return bodyStatements(node).filter((child) => child.type !== "comment");
}

const OWN_ROOT_TYPES = new Set([
  "program",
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

const BLOCK_TYPES = new Set(["block", "do_block"]);

const METHOD_TYPES = new Set(["method", "singleton_method"]);

const NAME_TYPES = new Set([
  "identifier",
  "constant",
  "instance_variable",
  "class_variable",
  "global_variable",
  "self",
]);

const LITERAL_TYPES: Record<string, (node: RbNode) => Expression<RbNode>> = {
  integer: (node) => ({ kind: "literal", value: Number(node.text) }),
  float: (node) => ({ kind: "literal", value: Number(node.text) }),
  true: () => ({ kind: "literal", value: true }),
  false: () => ({ kind: "literal", value: false }),
  nil: () => ({ kind: "literal", value: null }),
  simple_symbol: (node) => ({ kind: "literal", value: node.text.slice(1) }),
  bare_string: (node) => ({ kind: "literal", value: node.text }),
  bare_symbol: (node) => ({ kind: "literal", value: node.text }),
};

/** The method rows that write to their receiver rather than read it. */
const WRITING_ROWS = new Set(["push", "append", "concat", "<<"]);

/** The calls a block literal makes a callable value with. */
const LAMBDA_CALLS = new Set(["lambda", "proc"]);

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

export function rubyLowering(options: LoweringOptions): Lowering<RbNode> {
  const { context, rows } = options;
  const readingMethods = readingMethodsOf(rows);
  const mutatedByRoot = new Map<number, Set<string>>();

  return {
    idOf: (node) => node.id,
    expression: expressionOf,
    statement: statementOf,
    siteOf,
    functionOf,
    writtenTo: (node) => (context === null ? null : context.writtenTo(node)),
    callable: (node) => {
      if (!isInlinableCall(node)) {
        return null;
      }
      const resolved = context === null ? null : context.callable(node);
      return resolved ?? sameFileCallable(node);
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
export function placeholderName(node: RbNode): string {
  const peeled = peelValue(node);
  if (NAME_TYPES.has(peeled.type)) {
    return peeled.text.replace(/^@+|^\$/, "");
  }
  const environmentVariable = environmentVariableOf(peeled);
  if (environmentVariable !== null) {
    return environmentVariable;
  }
  if (peeled.type === "call" || peeled.type === "scope_resolution") {
    const name = field(peeled, peeled.type === "call" ? "method" : "name");
    return name === null ? "param" : name.text;
  }
  return "param";
}

/** Parentheses around a single expression do not change what a value is. */
export function peelValue(node: RbNode): RbNode {
  if (node.type !== "parenthesized_statements") {
    return node;
  }
  const inner = named(node);
  const only = inner[0];
  return inner.length === 1 && only !== undefined ? peelValue(only) : node;
}

const OPAQUE = { kind: "opaque" } as const;

/** Build from a node's named fields, or fall back when the parse left one out. */
function fromFields<T>(
  node: RbNode,
  names: readonly string[],
  fallback: T,
  build: (...parts: RbNode[]) => T,
): T {
  const found = names.map((name) => field(node, name));
  if (found.some((part) => part === null)) {
    return fallback;
  }
  return build(...(found as RbNode[]));
}

/** `ENV["X"]` reads the environment variable `X`; `ENV.fetch` is a row. */
function environmentVariableOf(node: RbNode): string | null {
  if (node.type !== "element_reference") {
    return null;
  }
  const receiver = field(node, "object");
  if (receiver === null || receiver.text !== "ENV") {
    return null;
  }
  const index = named(node).find((child) => child.id !== receiver.id);
  return index === undefined ? null : stringLiteralValue(index);
}

const EXPRESSION_TYPES: Record<string, (node: RbNode) => Expression<RbNode>> = {
  string: stringExpression,
  chained_string: (node) => ({
    kind: "template",
    parts: named(node).map((part) => ({ expression: part })),
  }),
  // A constant path is never bound locally, so the read falls through to
  // the `binds` fact that points at the constant's definition.
  scope_resolution: (node) => ({ kind: "name", text: node.text }),
  element_reference: (node) => {
    const object = field(node, "object");
    const indexes =
      object === null
        ? []
        : named(node).filter((child) => child.id !== object.id);
    const index = indexes[0];
    if (object === null || index === undefined || indexes.length !== 1) {
      return OPAQUE;
    }
    if (object.text === "ENV") {
      return OPAQUE;
    }
    return { kind: "element", object, index };
  },
  array: arrayExpression,
  string_array: arrayExpression,
  symbol_array: arrayExpression,
  hash: (node) => ({
    kind: "record",
    fields: named(node).flatMap(fieldOf),
  }),
  call: callExpression,
  binary: (node) =>
    fromFields<Expression<RbNode>>(
      node,
      ["left", "operator", "right"],
      OPAQUE,
      (left, operator, right) =>
        operator.text === "<<"
          ? shiftCall(left, right)
          : {
              kind: "operator",
              operator: operator.text,
              operands: [left, right],
            },
    ),
  unary: (node) => {
    const operand = field(node, "operand");
    const operator = node.children.find(
      (child): child is RbNode => child !== null && !child.isNamed,
    );
    if (operand === null || operator === undefined) {
      return OPAQUE;
    }
    return { kind: "operator", operator: operator.text, operands: [operand] };
  },
  conditional: (node) =>
    fromFields<Expression<RbNode>>(
      node,
      ["condition", "consequence", "alternative"],
      OPAQUE,
      (condition, whenTrue, whenFalse) => ({
        kind: "conditional",
        condition,
        whenTrue,
        whenFalse,
      }),
    ),
  lambda: (node) => ({ kind: "function", node }),
};

function expressionOf(node: RbNode): Expression<RbNode> {
  const peeled = peelValue(node);
  const literal = LITERAL_TYPES[peeled.type];
  if (literal !== undefined) {
    return literal(peeled);
  }
  if (NAME_TYPES.has(peeled.type)) {
    return { kind: "name", text: peeled.text };
  }
  const lower = EXPRESSION_TYPES[peeled.type];
  return lower === undefined ? OPAQUE : lower(peeled);
}

/** A plain string is a literal; one with interpolation is a template over its parts. */
function stringExpression(node: RbNode): Expression<RbNode> {
  const plain = stringLiteralValue(node);
  if (plain !== null) {
    return { kind: "literal", value: plain };
  }
  const parts: ({ text: string } | { expression: RbNode })[] = [];
  for (const child of named(node)) {
    if (child.type === "string_content") {
      parts.push({ text: child.text });
      continue;
    }
    if (child.type === "interpolation") {
      const expression = named(child)[0];
      if (expression !== undefined) {
        parts.push({ expression });
      }
    }
  }
  return { kind: "template", parts };
}

function arrayExpression(node: RbNode): Expression<RbNode> {
  return { kind: "array", items: named(node).map(elementOf) };
}

/**
 * `x.call(...)` and `lambda { }` are calls like any other; the lowering
 * reads a block literal handed to `lambda` or `proc` as a function value.
 * A receiverless call with no arguments parses as a bare identifier, so
 * a call node with a receiver and nothing else is a property read.
 */
function callExpression(node: RbNode): Expression<RbNode> {
  const method = field(node, "method");
  const receiver = field(node, "receiver");
  const block = blockOf(node);
  if (method === null) {
    return OPAQUE;
  }
  if (receiver === null && block !== null && LAMBDA_CALLS.has(method.text)) {
    return { kind: "function", node: block };
  }
  if (isAssignmentTarget(node) && receiver !== null) {
    return { kind: "member", object: receiver, name: method.text };
  }
  return {
    kind: "call",
    callee: {
      receiver,
      name: method.text,
      origin: () => originOf(node),
    },
    args: argumentsOf(node),
    constructs: method.text === "new",
  };
}

/** `a << b` is a method call on `a`, so an array on the heap is written in place. */
function shiftCall(left: RbNode, right: RbNode): Expression<RbNode> {
  return {
    kind: "call",
    callee: { receiver: left, name: "<<", origin: () => null },
    args: [elementOf(right)],
    constructs: false,
  };
}

function isAssignmentTarget(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    (parent.type === "assignment" || parent.type === "operator_assignment") &&
    field(parent, "left")?.id === node.id
  );
}

/**
 * Where a callee comes from is syntactic in Ruby: `File.join` is the
 * `join` of `File`, `A::B.m` the `m` of `A::B`, and a receiverless call
 * is one of `Kernel`'s.
 */
function originOf(call: RbNode): Origin | null {
  const method = field(call, "method");
  const receiver = field(call, "receiver");
  if (method === null) {
    return null;
  }
  if (receiver === null) {
    return { module: "Kernel", name: method.text };
  }
  const module = constantPathOf(receiver);
  return module === null ? null : { module, name: method.text };
}

/** `File`, `A::B` or `::A::B` as the text a callee row states, or null for anything else. */
function constantPathOf(node: RbNode): string | null {
  if (node.type === "constant") {
    return node.text;
  }
  if (node.type !== "scope_resolution") {
    return null;
  }
  const name = field(node, "name");
  const scope = field(node, "scope");
  if (name === null) {
    return null;
  }
  if (scope === null) {
    return name.text;
  }
  const outer = constantPathOf(scope);
  return outer === null ? null : `${outer}::${name.text}`;
}

function blockOf(call: RbNode): RbNode | null {
  return field(call, "block");
}

/** Every argument of a call. A `key: value` pair is a keyword argument; a `**opts` could fill any parameter, so it is left out. */
function argumentsOf(call: RbNode): Element<RbNode>[] {
  const argumentList = field(call, "arguments");
  if (argumentList === null) {
    return [];
  }
  return named(argumentList).flatMap((argument) => {
    if (argument.type === "hash_splat_argument") {
      return [];
    }
    if (argument.type !== "pair") {
      return [elementOf(argument)];
    }
    return fromFields(argument, ["key", "value"], [], (key, value) => {
      const name = hashKeySymbolName(key) ?? symbolValue(key);
      return name === null ? [] : [{ kind: "named", name, node: value }];
    });
  });
}

/** A call the engine can run the callee's body for: no `**opts`, and no block to yield to. */
function isInlinableCall(call: RbNode): boolean {
  if (call.type !== "call" || blockOf(call) !== null) {
    return false;
  }
  const argumentList = field(call, "arguments");
  return (
    argumentList === null ||
    named(argumentList).every(
      (argument) => argument.type !== "hash_splat_argument",
    )
  );
}

function elementOf(node: RbNode): Element<RbNode> {
  if (node.type === "splat_argument") {
    const inner = named(node)[0];
    return inner === undefined
      ? { kind: "value", node }
      : { kind: "spread", node: inner };
  }
  return { kind: "value", node };
}

function fieldOf(node: RbNode): Field<RbNode>[] {
  if (node.type === "hash_splat_argument") {
    const inner = named(node)[0];
    return inner === undefined ? [] : [{ kind: "spread", node: inner }];
  }
  if (node.type !== "pair") {
    return [];
  }
  return fromFields(node, ["key", "value"], [], (key, value) => {
    const name =
      hashKeySymbolName(key) ?? symbolValue(key) ?? stringLiteralValue(key);
    return name === null
      ? [{ kind: "computed", name: key, value }]
      : [{ kind: "field", name, value }];
  });
}

const STATEMENT_TYPES: Record<string, (node: RbNode) => Statement<RbNode>> = {
  assignment: (node) => assignment(node, null),
  operator_assignment: (node) =>
    assignment(node, field(node, "operator")?.text.slice(0, -1) ?? null),
  if: ifStatement,
  elsif: ifStatement,
  unless: (node) => ifStatement(node, true),
  if_modifier: modifierStatement,
  unless_modifier: (node) => modifierStatement(node, true),
  case: caseStatement,
  while: loopStatement,
  until: loopStatement,
  for: loopStatement,
  return: (node) => ({
    kind: "return",
    value: returnedValue(node),
  }),
  begin: (node) => ({ kind: "block", body: beginStatements(node) }),
  method: () => OPAQUE,
  singleton_method: () => OPAQUE,
  class: () => OPAQUE,
  module: () => OPAQUE,
  singleton_class: () => OPAQUE,
};

function statementOf(node: RbNode): Statement<RbNode> {
  const lower = STATEMENT_TYPES[node.type];
  if (lower !== undefined) {
    return lower(node);
  }
  const appending = appendingStatement(node);
  if (appending !== null) {
    return appending;
  }
  return isTailExpression(node)
    ? { kind: "return", value: node }
    : { kind: "expression", value: node };
}

/** `a << b` on its own line rebinds `a`, which matters when `a` is a string. */
function appendingStatement(node: RbNode): Statement<RbNode> | null {
  if (node.type !== "binary" || field(node, "operator")?.text !== "<<") {
    return null;
  }
  const left = field(node, "left");
  if (left === null || !NAME_TYPES.has(left.type)) {
    return null;
  }
  return { kind: "assign", target: left, operator: null, value: node };
}

/** `a = b` is an assignment; `a, b = c` declares each name with nothing readable behind it. */
function assignment(node: RbNode, operator: string | null): Statement<RbNode> {
  return fromFields<Statement<RbNode>>(
    node,
    ["left", "right"],
    OPAQUE,
    (target, value) => {
      if (target.type === "left_assignment_list") {
        return {
          kind: "declare",
          bindings: patternNames(target).map((name) => ({ name, value: null })),
        };
      }
      return { kind: "assign", target, operator, value };
    },
  );
}

function patternNames(pattern: RbNode): string[] {
  return named(pattern).flatMap((child) =>
    NAME_TYPES.has(child.type) ? [child.text] : patternNames(child),
  );
}

/** `if`/`elsif`/`else`: the other arm is the next clause. `unless` swaps the arms. */
function ifStatement(node: RbNode, negated = false): Statement<RbNode> {
  return fromFields<Statement<RbNode>>(
    node,
    ["condition"],
    OPAQUE,
    (condition) => {
      const consequence = field(node, "consequence");
      const taken = consequence === null ? [] : named(consequence);
      const other = otherArm(field(node, "alternative"));
      return {
        kind: "branch",
        condition,
        arms: negated ? [other, taken] : [taken, other],
      };
    },
  );
}

/** An `elsif` is a branch of its own; an `else` is the statements it wraps. */
function otherArm(alternative: RbNode | null): RbNode[] {
  if (alternative === null) {
    return [];
  }
  return alternative.type === "elsif" ? [alternative] : named(alternative);
}

function modifierStatement(node: RbNode, negated = false): Statement<RbNode> {
  return fromFields<Statement<RbNode>>(
    node,
    ["body", "condition"],
    OPAQUE,
    (body, condition) => ({
      kind: "branch",
      condition,
      arms: negated ? [[], [body]] : [[body], []],
    }),
  );
}

/** A `case` is a branch over every `when` and the `else`, with no one condition the engine can settle. */
function caseStatement(node: RbNode): Statement<RbNode> {
  const arms: RbNode[][] = [];
  let hasElse = false;
  for (const clause of named(node)) {
    if (clause.type === "when") {
      const body = field(clause, "body");
      arms.push(body === null ? [] : named(body));
    }
    if (clause.type === "else") {
      hasElse = true;
      arms.push(named(clause));
    }
  }
  if (!hasElse) {
    arms.push([]);
  }
  return { kind: "branch", condition: null, arms };
}

function loopStatement(node: RbNode): Statement<RbNode> {
  const body = field(node, "body");
  return { kind: "loop", body: body === null ? [] : named(body) };
}

function returnedValue(node: RbNode): RbNode | null {
  const argumentList = named(node)[0];
  if (argumentList === undefined) {
    return null;
  }
  const values = named(argumentList);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** A `begin` runs its statements and then its `ensure`; a `rescue` arm only runs when something threw. */
/** The statements a `begin` runs first, before any `rescue` or `ensure`. */
function mainStatements(node: RbNode): RbNode[] {
  return named(node).filter(
    (child) => child.type !== "rescue" && child.type !== "ensure",
  );
}

/** A `begin` is worth its last main statement; the `ensure` runs after but is not the value. */
function beginStatements(node: RbNode): RbNode[] {
  const ensure = named(node).find((child) => child.type === "ensure");
  return [
    ...mainStatements(node),
    ...(ensure === undefined ? [] : named(ensure)),
  ];
}

/** `if` with no `else`, and every `if` form, once the engine has the arms. */
const TAIL_BRANCH_TYPES = new Set([
  "if",
  "unless",
  "elsif",
  "case",
  "if_modifier",
  "unless_modifier",
  "begin",
  "parenthesized_statements",
]);

/** The parents whose last statement is the value of the thing around them. */
const TAIL_BODY_TYPES = new Set([
  "then",
  "else",
  "body_statement",
  "block_body",
]);

/**
 * Whether a statement's value is what its method, lambda or block
 * returns: the last statement of the body, or the last one of a
 * branch arm that is itself in tail position.
 */
function isTailExpression(node: RbNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return false;
  }
  if (node.type === "elsif") {
    return isTailExpression(parent);
  }
  if (parent.type === "if_modifier" || parent.type === "unless_modifier") {
    return field(parent, "body")?.id === node.id && isTailExpression(parent);
  }
  if (parent.type === "elsif" || parent.type === "when") {
    return false;
  }
  if (parent.type === "begin") {
    return (
      isLastStatement(node, mainStatements(parent)) && isTailExpression(parent)
    );
  }
  if (parent.type === "parenthesized_statements") {
    return isLastStatement(node, named(parent)) && isTailExpression(parent);
  }
  if (!TAIL_BODY_TYPES.has(parent.type)) {
    return false;
  }
  if (!isLastStatement(node, named(parent))) {
    return false;
  }
  const owner = parent.parent;
  if (owner === null) {
    return false;
  }
  if (owner.type === "block" && owner.parent?.type === "lambda") {
    return true;
  }
  if (METHOD_TYPES.has(owner.type) || BLOCK_TYPES.has(owner.type)) {
    return true;
  }
  if (owner.type === "when") {
    return owner.parent !== null && isTailExpression(owner.parent);
  }
  if (owner.type === "elsif") {
    return isTailExpression(owner);
  }
  return TAIL_BRANCH_TYPES.has(owner.type) && isTailExpression(owner);
}

function isLastStatement(node: RbNode, statements: readonly RbNode[]): boolean {
  const last = statements[statements.length - 1];
  return last !== undefined && last.id === node.id;
}

/** A block handed to a call runs as its own scope; the block inside a `-> {}` is the lambda's. */
function isRoot(node: RbNode): boolean {
  if (OWN_ROOT_TYPES.has(node.type)) {
    return true;
  }
  return BLOCK_TYPES.has(node.type) && node.parent?.type === "call";
}

/**
 * Whether `node` is one of the statements a branch, loop or block
 * lowers to: a child of the file or of a body, an `elsif`, which the
 * clause before it lists as its other arm, or the body of a modifier.
 */
function isPathStatement(node: RbNode, parent: RbNode): boolean {
  if (node.type === "elsif") {
    return true;
  }
  if (parent.type === "if_modifier" || parent.type === "unless_modifier") {
    return field(parent, "body")?.id === node.id;
  }
  return (
    parent.type === "program" ||
    parent.type === "begin" ||
    parent.type === "ensure" ||
    parent.type === "do" ||
    TAIL_BODY_TYPES.has(parent.type)
  );
}

function siteOf(node: RbNode): Site<RbNode> | null {
  const path: RbNode[] = [];
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

/** The parameters a list declares, in order; an optional or keyword parameter with its default. */
function parametersOf(parameters: RbNode | null): Parameter<RbNode>[] {
  if (parameters === null) {
    return [];
  }
  return named(parameters).flatMap((parameter) => {
    if (parameter.type === "identifier") {
      return [{ name: parameter.text, default: null }];
    }
    const name = field(parameter, "name");
    return name === null
      ? []
      : [{ name: name.text, default: field(parameter, "value") }];
  });
}

function functionOf(node: RbNode): FunctionShape<RbNode> | null {
  if (node.type === "program") {
    return { parameters: [], body: named(node) };
  }
  if (node.type === "lambda") {
    const block = field(node, "body");
    if (block === null) {
      return null;
    }
    return {
      parameters: parametersOf(field(node, "parameters")),
      body: bodyOf(block),
    };
  }
  if (BLOCK_TYPES.has(node.type)) {
    return {
      parameters: parametersOf(field(node, "parameters")),
      body: bodyOf(node),
    };
  }
  if (METHOD_TYPES.has(node.type)) {
    const body = field(node, "body");
    const parameters = parametersOf(field(node, "parameters"));
    if (body === null) {
      return { parameters, body: [] };
    }
    return body.type === "body_statement"
      ? { parameters, body: named(body) }
      : { parameters, body: { expression: body } };
  }
  if (OWN_ROOT_TYPES.has(node.type)) {
    const body = field(node, "body");
    return { parameters: [], body: body === null ? [] : named(body) };
  }
  return null;
}

function bodyOf(block: RbNode): RbNode[] {
  const body = field(block, "body");
  return body === null ? [] : named(body);
}

/**
 * The definition a call reaches within its own file: `def name` in the
 * enclosing class or at the top of the file, or the lambda a name was
 * assigned before `name.call(...)`.
 */
function sameFileCallable(call: RbNode): RbNode | null {
  const method = field(call, "method");
  const receiver = field(call, "receiver");
  if (method === null) {
    return null;
  }
  if (receiver !== null && method.text === "call") {
    return NAME_TYPES.has(receiver.type)
      ? lambdaAssignedTo(receiver.text, call)
      : null;
  }
  if (receiver !== null && receiver.type !== "self") {
    return null;
  }
  return definitionNamed(method.text, call, receiver !== null);
}

function definitionNamed(
  name: string,
  from: RbNode,
  singleton: boolean,
): RbNode | null {
  let scope = from.parent;
  while (scope !== null) {
    if (
      scope.type === "program" ||
      scope.type === "class" ||
      scope.type === "module"
    ) {
      const body = scope.type === "program" ? scope : field(scope, "body");
      const found =
        body === null
          ? undefined
          : named(body).find(
              (statement) =>
                statement.type ===
                  (singleton ? "singleton_method" : "method") &&
                field(statement, "name")?.text === name,
            );
      if (found !== undefined) {
        return found;
      }
    }
    scope = scope.parent;
  }
  return null;
}

/** The lambda or `proc` block assigned to `name` in a body around `from`, taking the nearest. */
function lambdaAssignedTo(name: string, from: RbNode): RbNode | null {
  let scope = from.parent;
  while (scope !== null) {
    for (const statement of named(scope)) {
      if (statement.startIndex >= from.startIndex) {
        break;
      }
      if (
        statement.type !== "assignment" ||
        field(statement, "left")?.text !== name
      ) {
        continue;
      }
      const value = field(statement, "right");
      const shape = value === null ? OPAQUE : expressionOf(value);
      if (shape.kind === "function") {
        return shape.node;
      }
    }
    scope = scope.parent;
  }
  return null;
}

function namesMutatedInNestedFunctions(
  root: RbNode,
  readingMethods: ReadonlySet<string>,
): Set<string> {
  const mutated = new Set<string>();
  const visit = (node: RbNode, nested: boolean): void => {
    const name = writtenNameOf(node, readingMethods);
    if (nested && name !== null) {
      mutated.add(name);
    }
    for (const child of named(node)) {
      visit(child, nested || isRoot(child));
    }
  };
  for (const child of named(root)) {
    visit(child, isRoot(child));
  }
  return mutated;
}

function writtenNameOf(
  node: RbNode,
  readingMethods: ReadonlySet<string>,
): string | null {
  if (node.type === "assignment" || node.type === "operator_assignment") {
    const target = field(node, "left");
    return target !== null && NAME_TYPES.has(target.type) ? target.text : null;
  }
  if (node.type === "binary" && field(node, "operator")?.text === "<<") {
    const target = field(node, "left");
    return target !== null && NAME_TYPES.has(target.type) ? target.text : null;
  }
  if (node.type === "call") {
    const receiver = field(node, "receiver");
    const method = field(node, "method");
    if (
      receiver !== null &&
      NAME_TYPES.has(receiver.type) &&
      method !== null &&
      !readingMethods.has(method.text)
    ) {
      return receiver.text;
    }
  }
  return null;
}

const DECLARING_PARENTS = new Set([
  "method_parameters",
  "lambda_parameters",
  "block_parameters",
  "optional_parameter",
  "keyword_parameter",
  "splat_parameter",
  "hash_splat_parameter",
  "block_parameter",
  "left_assignment_list",
  "destructured_parameter",
  "for",
]);

function freeNamesOf(fn: RbNode): readonly string[] {
  const declared = new Set<string>();
  const read = new Set<string>();
  const visit = (node: RbNode): void => {
    for (const child of named(node)) {
      if (!NAME_TYPES.has(child.type)) {
        visit(child);
        continue;
      }
      if (node.type === "call" && field(node, "method")?.id === child.id) {
        continue;
      }
      if (node.type === "pair" && field(node, "key")?.id === child.id) {
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

/**
 * The Ruby lowering a sound evaluator runs over: the plain one with
 * three things made strict, since a sound run must never give a value
 * some run of the program would not have.
 *
 * - A call inlines only when it calls, on `self`, a method no other
 *   method in the project shares a name with, so no subclass or mixin
 *   can run something else, and only when every `return` in the method
 *   is one the lowering reads. A `return` in a block leaves the method.
 * - A local is read only when the method binds it once and nothing
 *   writes it again, a block's parameter included.
 * - A `begin` with a `rescue` is opaque, and so is the value of a method
 *   that ends on an assignment or returns several values.
 */

import {
  children,
  field,
  hashKeySymbolName,
  METHOD_TYPES,
  symbolValue,
} from "../ast.js";
import { isRoot, isTailExpression, rubyLowering } from "./lowering.js";
import { rubySoundRows } from "./rows.js";

import type { Lowering, Statement } from "@suss/values";
import type { RbNode } from "../parser.js";
import type { EvaluationContext } from "./lowering.js";

export interface SoundLoweringOptions {
  readonly context: EvaluationContext | null;
  /** How many methods the project defines under a name, instance and singleton alike. */
  readonly definitionsNamed: (name: string) => number;
}

const NO_OP: Statement<RbNode> = { kind: "block", body: [] };
const OPAQUE: Statement<RbNode> = { kind: "opaque" };

/** Statements that move control within a loop and give the method no value. */
const NO_OP_TYPES = new Set(["break", "next", "redo"]);

/** How the plain lowering reads `a = b`, `a, b = c` and `a << b`, which give a method that ends on them a value. */
const VALUED_STATEMENT_KINDS = new Set(["assign", "declare"]);

/** The parameters the engine binds the way Ruby does: one argument each, by position or by keyword. */
const BOUND_PARAMETER_TYPES = new Set([
  "identifier",
  "optional_parameter",
  "keyword_parameter",
  "block_parameter",
]);

/** Nodes a `return` may sit in, for the engine to read it as the method's return. */
const PATH_TYPES = new Set([
  "body_statement",
  "then",
  "else",
  "if",
  "unless",
  "elsif",
  "case",
  "when",
  "begin",
  "ensure",
  "if_modifier",
  "unless_modifier",
  "parenthesized_statements",
]);

/** Scopes of their own, whose locals belong to them. A block or a lambda shares the locals around it. */
const SCOPE_TYPES = new Set([
  ...METHOD_TYPES,
  "class",
  "module",
  "singleton_class",
]);

/** What a `return` written inside leaves, instead of the method around it. */
const RETURNING_TYPES = new Set([...SCOPE_TYPES, "lambda"]);

/** The parameters a call fills one argument each, by position or keyword. */
const PLAIN_PARAMETER_TYPES = new Set([
  "optional_parameter",
  "keyword_parameter",
]);

export function rubySoundLowering(
  options: SoundLoweringOptions,
): Lowering<RbNode> {
  const base = rubyLowering({ context: options.context, rows: rubySoundRows });
  const writtenOnceByRoot = new Map<number, ReadonlySet<string>>();
  return {
    ...base,
    statement: (node) =>
      soundStatementOf(node) ?? withTailValue(node, base.statement(node)),
    callable: (node) => {
      const target = base.callable(node);
      return target !== null &&
        callsExactly(node, target, options.definitionsNamed)
        ? target
        : null;
    },
    writtenOnce: (root, name) => {
      let names = writtenOnceByRoot.get(root.id);
      if (names === undefined) {
        names = namesWrittenOnce(root);
        writtenOnceByRoot.set(root.id, names);
      }
      return names.has(name);
    },
  };
}

function soundStatementOf(node: RbNode): Statement<RbNode> | null {
  if (NO_OP_TYPES.has(node.type)) {
    return NO_OP;
  }
  // A `return` in an `ensure` replaces whatever the body returned.
  if (
    node.type === "begin" &&
    children(node).some(
      (part) =>
        part.type === "rescue" || (part.type === "ensure" && returnsFrom(part)),
    )
  ) {
    return OPAQUE;
  }
  // `return a, b` returns a list, which the plain lowering leaves unread.
  if (
    node.type === "return" &&
    children(children(node)[0] ?? null).length > 1
  ) {
    return { kind: "return", value: node };
  }
  return null;
}

/** A method that ends on an assignment returns what was assigned, which the engine cannot read off the statement. */
function withTailValue(
  node: RbNode,
  lowered: Statement<RbNode>,
): Statement<RbNode> {
  return VALUED_STATEMENT_KINDS.has(lowered.kind) && isTailExpression(node)
    ? { kind: "return", value: node }
    : lowered;
}

/**
 * Whether the call runs `target` and nothing else: a call on `self`, by
 * the method's own name, to a method no other definition in the project
 * shares a name with, from a method of the same kind, binding its
 * arguments the way Ruby will.
 */
function callsExactly(
  call: RbNode,
  target: RbNode,
  definitionsNamed: (name: string) => number,
): boolean {
  const method = field(call, "method");
  const receiver = field(call, "receiver");
  if (
    method === null ||
    method.text === "new" ||
    (receiver !== null && receiver.type !== "self") ||
    !METHOD_TYPES.has(target.type) ||
    field(target, "name")?.text !== method.text ||
    enclosingMethodOf(call)?.type !== target.type ||
    definitionsNamed(method.text) !== 1 ||
    passesABlock(call) ||
    !bindsAsRubyDoes(call, target)
  ) {
    return false;
  }
  return everyReturnIsRead(target);
}

/**
 * Whether the engine binds the call's arguments the way Ruby will. Ruby
 * fills required parameters before optional ones written ahead of them,
 * gathers a splat, and hands `key: value` arguments to a positional
 * parameter as a hash when no keyword parameter has that name.
 */
function bindsAsRubyDoes(call: RbNode, method: RbNode): boolean {
  const parameters = children(field(method, "parameters"));
  if (!parameters.every((one) => BOUND_PARAMETER_TYPES.has(one.type))) {
    return false;
  }
  const firstOptional = parameters.findIndex(
    (one) => one.type === "optional_parameter",
  );
  if (
    firstOptional !== -1 &&
    parameters.slice(firstOptional).some((one) => one.type === "identifier")
  ) {
    return false;
  }
  const keywords = new Set(
    parameters
      .filter((one) => one.type === "keyword_parameter")
      .map((one) => field(one, "name")?.text),
  );
  return children(field(call, "arguments")).every((argument) => {
    if (argument.type !== "pair") {
      return true;
    }
    const key = field(argument, "key");
    const name =
      key === null ? null : (hashKeySymbolName(key) ?? symbolValue(key));
    return name !== null && keywords.has(name);
  });
}

function enclosingMethodOf(node: RbNode): RbNode | null {
  let current = node.parent;
  while (current !== null && !METHOD_TYPES.has(current.type)) {
    current = current.parent;
  }
  return current;
}

function passesABlock(call: RbNode): boolean {
  return children(field(call, "arguments")).some(
    (argument) => argument.type === "block_argument",
  );
}

/** Whether every `return` that leaves `method` is one the lowering reads as its return. */
function everyReturnIsRead(method: RbNode): boolean {
  const visit = (node: RbNode): boolean =>
    children(node).every((child) => {
      if (RETURNING_TYPES.has(child.type)) {
        return true;
      }
      if (child.type === "return" && !onAPath(child, method)) {
        return false;
      }
      return visit(child);
    });
  return visit(field(method, "body") ?? method);
}

/** Whether a `return` is written under `node`, outside any scope nested in it. */
function returnsFrom(node: RbNode): boolean {
  return children(node).some(
    (child) =>
      child.type === "return" ||
      (!RETURNING_TYPES.has(child.type) && returnsFrom(child)),
  );
}

function onAPath(node: RbNode, method: RbNode): boolean {
  let current = node.parent;
  while (current !== null && current.id !== method.id) {
    if (!PATH_TYPES.has(current.type)) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

/**
 * The locals `root` binds exactly once and never writes again. Every
 * write anywhere in `root` counts, a block's included, since a block
 * shares the method's locals and its parameters shadow them.
 */
function namesWrittenOnce(root: RbNode): ReadonlySet<string> {
  const once = new Set<string>();
  for (const [name, written] of writesIn(root)) {
    const only = written[0];
    if (written.length === 1 && only !== undefined && isTrusted(only, root)) {
      once.add(name);
    }
  }
  return once;
}

/** The names `root` and the blocks inside it write more than once, a parameter counted as a write. */
export function namesWrittenAgain(root: RbNode): ReadonlySet<string> {
  return new Set(
    [...writesIn(root)].flatMap(([name, written]) =>
      written.length > 1 ? [name] : [],
    ),
  );
}

/** Every write to each name in `root`'s scope, a parameter counted as one. */
function writesIn(root: RbNode): ReadonlyMap<string, readonly RbNode[]> {
  const writes = new Map<string, RbNode[]>();
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      if (SCOPE_TYPES.has(child.type)) {
        continue;
      }
      const name = writtenName(child);
      if (name !== null) {
        writes.set(name, [...(writes.get(name) ?? []), child]);
      }
      visit(child);
    }
  };
  visit(field(root, "body") ?? root);
  for (const parameter of children(field(root, "parameters"))) {
    const name = parameterName(parameter);
    if (name !== null) {
      writes.set(name.text, [...(writes.get(name.text) ?? []), parameter]);
    }
  }
  return writes;
}

/** The name an identifier binds or writes, or a pattern binds with a key alone, as `in {id:}` does. */
function writtenName(node: RbNode): string | null {
  if (node.type === "hash_key_symbol") {
    return node.parent?.type === "keyword_pattern" ? node.text : null;
  }
  if (node.type !== "identifier") {
    return null;
  }
  let current = node;
  let parent = current.parent;
  while (
    parent !== null &&
    (parent.type === "left_assignment_list" ||
      parent.type === "destructured_left_assignment" ||
      parent.type === "rest_assignment")
  ) {
    current = parent;
    parent = current.parent;
  }
  if (parent === null) {
    return null;
  }
  return bindsThrough(parent, current) ? node.text : null;
}

function bindsThrough(parent: RbNode, current: RbNode): boolean {
  if (parent.type === "assignment" || parent.type === "operator_assignment") {
    return field(parent, "left")?.id === current.id;
  }
  if (parent.type === "for") {
    return field(parent, "pattern")?.id === current.id;
  }
  return (
    parent.type === "block_parameters" ||
    parent.type === "lambda_parameters" ||
    parent.type === "method_parameters" ||
    parent.type === "exception_variable" ||
    parent.type === "destructured_parameter" ||
    parent.type === "splat_parameter" ||
    parent.type === "hash_splat_parameter" ||
    parent.type === "block_parameter" ||
    parent.type === "optional_parameter" ||
    parent.type === "keyword_parameter" ||
    insidePattern(parent)
  );
}

function insidePattern(node: RbNode): boolean {
  let current: RbNode | null = node;
  while (current !== null) {
    if (current.type === "in_clause") {
      return true;
    }
    if (current.type === "then" || SCOPE_TYPES.has(current.type)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** The name a parameter of `root` binds, or null for one this does not read. */
function parameterName(parameter: RbNode): RbNode | null {
  if (parameter.type === "identifier") {
    return parameter;
  }
  return field(parameter, "name");
}

/**
 * Whether the one write of a local is one the engine follows: a plain
 * `name = value` statement in `root` itself, or a parameter of `root`
 * that takes one argument.
 */
function isTrusted(write: RbNode, root: RbNode): boolean {
  if (write.parent?.id === field(root, "parameters")?.id) {
    return write.type === "identifier" || PLAIN_PARAMETER_TYPES.has(write.type);
  }
  const assignment = write.parent;
  return (
    assignment?.type === "assignment" &&
    field(assignment, "left")?.id === write.id &&
    enclosingRootOf(assignment)?.id === root.id
  );
}

function enclosingRootOf(node: RbNode): RbNode | null {
  let current = node.parent;
  while (current !== null && !isRoot(current)) {
    current = current.parent;
  }
  return current;
}

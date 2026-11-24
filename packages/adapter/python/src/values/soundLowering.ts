/**
 * The Python lowering a sound evaluator runs over: the plain one with
 * three things made strict, since a sound run must never give a value
 * some run of the program would not have.
 *
 * - A call inlines only when it calls, by its plain name, an undecorated
 *   function defined under that name, and an `async def` only when
 *   awaited. A method, a class or a generator may run something else.
 * - A name is read only when the function binds it once and nothing
 *   writes it again, so a `for`, a `with ... as` or a walrus never leaves
 *   a stale value.
 * - A statement that may end the function some way the plain lowering
 *   leaves out, an `except` or a loop's `else`, is opaque.
 */

import { children, field } from "../ast.js";
import { isMethod, isRoot, peelValue, pythonLowering } from "./lowering.js";
import { pythonSoundRows } from "./rows.js";

import type { Lowering, Statement } from "@suss/values";
import type { PyNode } from "../parser.js";
import type { LoweringOptions } from "./lowering.js";

const NO_OP: Statement<PyNode> = { kind: "block", body: [] };
const OPAQUE: Statement<PyNode> = { kind: "opaque" };

/** Statements that give the function no value and never change an object the evaluator keeps. */
const NO_OP_TYPES = new Set([
  "pass_statement",
  "comment",
  "break_statement",
  "continue_statement",
  "global_statement",
  "nonlocal_statement",
  "import_statement",
  "import_from_statement",
  "future_import_statement",
  "assert_statement",
  "type_alias_statement",
]);

/** Statements whose effect the evaluator cannot follow at all. */
const OPAQUE_TYPES = new Set([
  "delete_statement",
  "match_statement",
  "class_definition",
  "decorated_definition",
]);

const HANDLER_TYPES = new Set([
  "except_clause",
  "except_group_clause",
  "else_clause",
]);

/** A default every call shares, and that nothing can change in place. */
const IMMUTABLE_DEFAULT_TYPES = new Set([
  "none",
  "true",
  "false",
  "integer",
  "float",
  "string",
]);

const PARAMETER_HOLDERS = new Set(["parameters", "lambda_parameters"]);

/** Parameters that gather or divide arguments, which the engine does not bind the way Python does. */
const SPLAT_PARAMETER_TYPES = new Set([
  "list_splat_pattern",
  "dictionary_splat_pattern",
  "keyword_separator",
  "positional_separator",
]);

const NAMED_PARAMETER_TYPES = new Set([
  "default_parameter",
  "typed_parameter",
  "typed_default_parameter",
]);

/** Nodes an assignment target passes through on its way down to a name. */
const PATTERN_TYPES = new Set([
  "pattern_list",
  "tuple_pattern",
  "list_pattern",
  "list_splat_pattern",
  "tuple",
  "list",
  "expression_list",
  "parenthesized_expression",
  "as_pattern_target",
]);

/** A `case` pattern and an import, which bind every name written inside them. */
const BINDING_PLACES = [
  "case_pattern",
  "import_statement",
  "import_from_statement",
];

export function pythonSoundLowering(
  options: Omit<LoweringOptions, "rows">,
): Lowering<PyNode> {
  const base = pythonLowering({ ...options, rows: pythonSoundRows });
  const writtenOnceByRoot = new Map<number, ReadonlySet<string>>();
  return {
    ...base,
    expression: (node) =>
      node.type === "function_definition"
        ? { kind: "function", node }
        : base.expression(node),
    statement: (node) => soundStatementOf(node) ?? base.statement(node),
    callable: (node) => {
      const call = peelValue(node);
      const target = call.type === "call" ? base.callable(call) : null;
      return target !== null && callsExactly(node, call, target)
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

function soundStatementOf(node: PyNode): Statement<PyNode> | null {
  if (NO_OP_TYPES.has(node.type)) {
    return NO_OP;
  }
  if (OPAQUE_TYPES.has(node.type)) {
    return OPAQUE;
  }
  // A function defined here runs later and may change what it reads, so
  // the engine reads it as a function value.
  if (node.type === "function_definition") {
    return { kind: "expression", value: node };
  }
  // A `return` in a `finally` replaces whatever the body returned.
  if (
    node.type === "try_statement" &&
    children(node).some(
      (clause) =>
        HANDLER_TYPES.has(clause.type) ||
        (clause.type === "finally_clause" && returnsFrom(clause)),
    )
  ) {
    return OPAQUE;
  }
  if (
    (node.type === "for_statement" || node.type === "while_statement") &&
    field(node, "alternative") !== null
  ) {
    return OPAQUE;
  }
  // A context manager may swallow an exception, and then the body stops
  // anywhere and the statements after it still run.
  if (node.type === "with_statement") {
    return {
      kind: "branch",
      condition: null,
      arms: [children(field(node, "body")), []],
    };
  }
  return null;
}

/**
 * Whether the call runs `target` and nothing else: it calls by plain
 * name the function defined under that name, which nothing decorates,
 * and gets back what that function returns.
 */
function callsExactly(node: PyNode, call: PyNode, target: PyNode): boolean {
  const callee = field(call, "function");
  const name = callee === null ? null : peelValue(callee);
  if (
    name?.type !== "identifier" ||
    target.type !== "function_definition" ||
    field(target, "name")?.text !== name.text ||
    target.parent?.type === "decorated_definition" ||
    isMethod(target) ||
    hasSplatParameters(target) ||
    yieldsValues(target)
  ) {
    return false;
  }
  return !isAsync(target) || isAwaited(node);
}

function isAsync(fn: PyNode): boolean {
  return fn.children[0]?.type === "async";
}

function isAwaited(node: PyNode): boolean {
  let current = node;
  while (current.type === "parenthesized_expression") {
    const inner = children(current)[0];
    if (inner === undefined) {
      return false;
    }
    current = inner;
  }
  return current.type === "await";
}

/** A typed splat, `*args: int`, wraps its pattern, so each parameter's children are asked too. */
function hasSplatParameters(fn: PyNode): boolean {
  return children(field(fn, "parameters")).some((parameter) =>
    [parameter, ...children(parameter)].some((part) =>
      SPLAT_PARAMETER_TYPES.has(part.type),
    ),
  );
}

/** Whether a function's own body yields, which makes calling it give back a generator. */
function yieldsValues(fn: PyNode): boolean {
  return writesOwn(fn, "yield");
}

function returnsFrom(clause: PyNode): boolean {
  return writesOwn(clause, "return_statement");
}

/** Whether a node of `type` is written under `node`, outside any function nested in it. */
function writesOwn(node: PyNode, type: string): boolean {
  return children(node).some(
    (child) =>
      child.type === type ||
      (child.type !== "function_definition" &&
        child.type !== "lambda" &&
        writesOwn(child, type)),
  );
}

/**
 * The names `root` binds exactly once and never writes again. Every
 * identifier anywhere in `root` that binds or writes counts, a nested
 * function's and a comprehension's included, so a name that is local
 * to something nested inside is untrusted too.
 */
function namesWrittenOnce(root: PyNode): ReadonlySet<string> {
  const writes = new Map<string, PyNode[]>();
  const visit = (node: PyNode): void => {
    for (const child of children(node)) {
      if (child.type === "identifier" && writesName(child)) {
        writes.set(child.text, [...(writes.get(child.text) ?? []), child]);
      }
      visit(child);
    }
  };
  visit(root);
  const once = new Set<string>();
  for (const [name, written] of writes) {
    const only = written[0];
    if (written.length === 1 && only !== undefined && isTrusted(only, root)) {
      once.add(name);
    }
  }
  return once;
}

/** The names `root` and the functions inside it write more than once. */
export function namesWrittenAgain(root: PyNode): ReadonlySet<string> {
  const writes = new Map<string, number>();
  const visit = (node: PyNode): void => {
    for (const child of children(node)) {
      if (child.type === "identifier" && writesName(child)) {
        writes.set(child.text, (writes.get(child.text) ?? 0) + 1);
      }
      visit(child);
    }
  };
  visit(root);
  return new Set(
    [...writes].flatMap(([name, count]) => (count > 1 ? [name] : [])),
  );
}

/** Whether an identifier binds the name it spells, or writes to it. */
function writesName(id: PyNode): boolean {
  if (BINDING_PLACES.some((type) => inside(id, type))) {
    return true;
  }
  let current = id;
  let parent = current.parent;
  while (parent !== null && PATTERN_TYPES.has(parent.type)) {
    current = parent;
    parent = current.parent;
  }
  return parent !== null && bindsThrough(parent, current, id);
}

/** Whether `parent` binds or writes the name `id` spells, reached through its child `current`. */
function bindsThrough(parent: PyNode, current: PyNode, id: PyNode): boolean {
  if (
    parent.type === "assignment" ||
    parent.type === "augmented_assignment" ||
    parent.type === "for_statement" ||
    parent.type === "for_in_clause"
  ) {
    return field(parent, "left")?.id === current.id;
  }
  if (parent.type === "named_expression") {
    return field(parent, "name")?.id === current.id;
  }
  if (parent.type === "as_pattern") {
    return current.type === "as_pattern_target";
  }
  if (
    parent.type === "function_definition" ||
    parent.type === "class_definition"
  ) {
    return field(parent, "name")?.id === id.id;
  }
  if (NAMED_PARAMETER_TYPES.has(parent.type)) {
    return (field(parent, "name") ?? children(parent)[0])?.id === current.id;
  }
  return (
    PARAMETER_HOLDERS.has(parent.type) ||
    parent.type === "dictionary_splat_pattern" ||
    parent.type === "delete_statement" ||
    parent.type === "global_statement" ||
    parent.type === "nonlocal_statement"
  );
}

function inside(node: PyNode, type: string): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current.type === type) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Whether the one write of a name is one the engine follows: a plain
 * `name = value` statement in `root` itself, or a parameter of `root`
 * whose default, if it has one, nothing can change in place.
 */
function isTrusted(id: PyNode, root: PyNode): boolean {
  const parent = id.parent;
  if (parent === null) {
    return false;
  }
  if (parent.type === "assignment") {
    return (
      field(parent, "left")?.id === id.id &&
      parent.parent?.type === "expression_statement" &&
      enclosingRoot(parent)?.id === root.id
    );
  }
  if (PARAMETER_HOLDERS.has(parent.type)) {
    return parent.parent?.id === root.id;
  }
  if (!NAMED_PARAMETER_TYPES.has(parent.type)) {
    return false;
  }
  const fallback = field(parent, "value");
  return (
    parent.parent?.parent?.id === root.id &&
    (fallback === null || IMMUTABLE_DEFAULT_TYPES.has(fallback.type))
  );
}

function enclosingRoot(node: PyNode): PyNode | null {
  let current = node.parent;
  while (current !== null && !isRoot(current)) {
    current = current.parent;
  }
  return current;
}

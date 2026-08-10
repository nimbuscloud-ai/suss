// values.ts: the facts @suss/resolution already joins, emitted for Python.
// The relation names and shapes come from that package's own header, so a
// Python value follows the same rules a TypeScript one does.

import { field } from "../ast.js";

import type { Database } from "@suss/datalog";
import type { PyNode } from "../parser.js";

/**
 * A node's identity across the whole run. The end is part of it because a
 * call and its callee start at the same offset.
 */
export function nodeId(filePath: string, node: PyNode): string {
  return `${filePath}:${node.startIndex}-${node.endIndex}`;
}

/** A name in a file, which is what a binding joins on. */
function nameId(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

const FUNCTION_TYPES = new Set(["function_definition", "lambda"]);

/** Written out in the source rather than a name for something written elsewhere. */
const WRITTEN_VALUE_TYPES = new Set([
  "string",
  "integer",
  "float",
  "true",
  "false",
  "none",
  "concatenated_string",
]);

/** A sequence keeps its elements under their positions, the way TypeScript's arrays do, so one property rule covers `items[0]`. */
const SEQUENCE_TYPES = new Set(["list", "tuple", "set"]);

/** `*args` and `**kwargs` collect what is left rather than taking one value. */
const SPLAT_TYPES = new Set(["list_splat_pattern", "dictionary_splat_pattern"]);

/**
 * What a parameter is called. `loader: ApplicationLoader` is a
 * `typed_parameter`, which the grammar gives no name field, so the name is the
 * identifier it starts with.
 */
function parameterName(param: PyNode): PyNode | null {
  if (param.type === "identifier") {
    return param;
  }
  const named = field(param, "name");
  if (named !== null) {
    return named;
  }
  return children(param).find((child) => child.type === "identifier") ?? null;
}

/** tree-sitter types a named child as nullable; dropping them once keeps every walk below flat. */
function children(node: PyNode): PyNode[] {
  return node.namedChildren.filter((child): child is PyNode => child !== null);
}

interface Emitter {
  db: Database;
  filePath: string;
  /**
   * The function whose body is being walked, and the parameters it declares.
   * A parameter is keyed under its own function, because two functions in one
   * file can both declare a `loader` and they are not the same value.
   */
  enclosing: { funcKey: string; params: ReadonlySet<string> } | null;
}

function add(emitter: Emitter, relation: string, ...tuple: string[]): void {
  emitter.db.add(relation, tuple);
}

/** The callee of a call, and the arguments it passes by position. */
function emitCall(emitter: Emitter, call: PyNode): void {
  // A call is written out in the source, so a name bound to one ends its
  // chain there. It gets no `comesTo`, which is the rules' own decision
  // about a factory call, and `isWrittenAs` is what reads it back.
  add(emitter, "writtenValue", nodeId(emitter.filePath, call));

  const callee = field(call, "function");
  if (callee === null) {
    return;
  }
  const callKey = nodeId(emitter.filePath, call);
  add(emitter, "call", callKey, valueKey(emitter, callee));

  const args = field(call, "arguments");
  if (args === null) {
    return;
  }
  let position = 0;
  for (const argument of children(args)) {
    if (argument.type === "keyword_argument") {
      const name = field(argument, "name");
      const value = field(argument, "value");
      if (name !== null && value !== null) {
        add(
          emitter,
          "callKeywordArg",
          callKey,
          name.text,
          valueKey(emitter, value),
        );
      }
      continue;
    }
    add(
      emitter,
      "callArg",
      callKey,
      String(position),
      valueKey(emitter, argument),
    );
    position += 1;
  }
}

/**
 * The key a value joins on. A bare name joins on the name, so a read of `x`
 * meets whatever `x` was bound to; anything else joins on its own node.
 */
function valueKey(emitter: Emitter, value: PyNode): string {
  if (value.type !== "identifier") {
    return nodeId(emitter.filePath, value);
  }
  const enclosing = emitter.enclosing;
  if (enclosing !== null && enclosing.params.has(value.text)) {
    return `${enclosing.funcKey}#${value.text}`;
  }
  return nameId(emitter.filePath, value.text);
}

/** A sequence is an object whose keys are positions. */
function emitSequence(emitter: Emitter, sequence: PyNode): void {
  const objectKey = nodeId(emitter.filePath, sequence);
  add(emitter, "objectValue", objectKey);
  let position = 0;
  for (const element of children(sequence)) {
    add(
      emitter,
      "holdsProperty",
      objectKey,
      String(position),
      valueKey(emitter, element),
    );
    position += 1;
  }
}

/** A dictionary is an object whose string keys contain values. */
function emitDictionary(emitter: Emitter, dictionary: PyNode): void {
  const objectKey = nodeId(emitter.filePath, dictionary);
  add(emitter, "objectValue", objectKey);
  for (const pair of children(dictionary)) {
    if (pair.type !== "pair") {
      continue;
    }
    const key = field(pair, "key");
    const value = field(pair, "value");
    if (key === null || value === null || key.type !== "string") {
      continue;
    }
    add(
      emitter,
      "holdsProperty",
      objectKey,
      key.text.slice(1, -1),
      valueKey(emitter, value),
    );
  }
}

/** `a.b` read as a property of `a`. */
function emitAttribute(emitter: Emitter, attribute: PyNode): void {
  const object = field(attribute, "object");
  const property = field(attribute, "attribute");
  if (object === null || property === null) {
    return;
  }
  add(
    emitter,
    "readsProperty",
    nodeId(emitter.filePath, attribute),
    valueKey(emitter, object),
    property.text,
  );
}

/** Every expression under a node, without crossing into a nested function. */
function walkExpressions(
  emitter: Emitter,
  node: PyNode,
  visit: (child: PyNode) => void,
): void {
  for (const child of children(node)) {
    if (FUNCTION_TYPES.has(child.type)) {
      continue;
    }
    visit(child);
    walkExpressions(emitter, child, visit);
  }
}

/** What one expression says about itself, whichever walk reached it. */
function emitExpressionFact(emitter: Emitter, child: PyNode): void {
  if (child.type === "call") {
    emitCall(emitter, child);
  }
  if (child.type === "dictionary") {
    emitDictionary(emitter, child);
  }
  if (SEQUENCE_TYPES.has(child.type)) {
    emitSequence(emitter, child);
  }
  if (child.type === "attribute") {
    emitAttribute(emitter, child);
  }
  if (WRITTEN_VALUE_TYPES.has(child.type)) {
    add(emitter, "writtenValue", nodeId(emitter.filePath, child));
  }
}

function emitExpressionFacts(emitter: Emitter, node: PyNode): void {
  walkExpressions(emitter, node, (child) => {
    emitExpressionFact(emitter, child);
  });
}

/**
 * A function's parameters by position, its returns, and the calls its body
 * makes. Where its name goes is the caller's to say, because a method belongs
 * to its class and a def belongs to its module.
 */
function emitFunctionFacts(
  emitter: Emitter,
  fn: PyNode,
  isMethod = false,
): string {
  const funcKey = nodeId(emitter.filePath, fn);
  add(emitter, "func", funcKey);

  const params = field(fn, "parameters");
  const declared = new Set<string>();
  // A method's first parameter is the receiver, which the caller does not
  // write, so counting it would put the first written argument in it.
  let position = isMethod ? -1 : 0;
  let byPosition = true;
  for (const param of params === null ? [] : children(params)) {
    if (SPLAT_TYPES.has(param.type)) {
      // What follows a `*` can only be passed by name.
      byPosition = false;
      continue;
    }
    const paramName = parameterName(param);
    if (paramName !== null) {
      declared.add(paramName.text);
      const paramKey = `${funcKey}#${paramName.text}`;
      if (byPosition && position >= 0) {
        add(emitter, "paramOf", funcKey, String(position), paramKey);
      }
      add(emitter, "paramNamed", funcKey, paramName.text, paramKey);
    }
    position += 1;
  }

  const inside: Emitter = {
    ...emitter,
    enclosing: { funcKey, params: declared },
  };

  const body = field(fn, "body");
  if (body === null) {
    return funcKey;
  }

  // The expression walk stops at a nested function, so the nesting itself
  // is recorded by its own scan.
  const recordNested = (node: PyNode): void => {
    for (const child of children(node)) {
      if (FUNCTION_TYPES.has(child.type)) {
        add(emitter, "containsFn", funcKey, nodeId(emitter.filePath, child));
        continue;
      }
      recordNested(child);
    }
  };
  recordNested(body);

  // One walk for both, since this function's own facts and the expression
  // facts want the same nodes and the walk is the expensive part.
  walkExpressions(inside, body, (child) => {
    if (child.type === "return_statement") {
      const returned = child.namedChildren[0];
      if (returned != null) {
        add(inside, "returnsValue", funcKey, valueKey(inside, returned));
      }
    }
    if (child.type === "call") {
      add(inside, "bodyCalls", funcKey, nodeId(inside.filePath, child));
    }
    emitExpressionFact(inside, child);
  });

  return funcKey;
}

/** `name = value` at any level, which is what a chain follows one hop of. */
function emitAssignment(emitter: Emitter, assignment: PyNode): void {
  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (left === null || right === null || left.type !== "identifier") {
    return;
  }
  add(
    emitter,
    "binds",
    nameId(emitter.filePath, left.text),
    valueKey(emitter, right),
  );
  add(
    emitter,
    "exportsAs",
    emitter.filePath,
    left.text,
    valueKey(emitter, right),
  );
}

/** The declaration a class-body statement makes, under whatever the grammar wraps it in. */
function declaredBy(statement: PyNode): PyNode {
  if (statement.type === "decorated_definition") {
    return field(statement, "definition") ?? statement;
  }
  if (statement.type === "expression_statement") {
    return children(statement)[0] ?? statement;
  }
  return statement;
}

/**
 * A class is an object containing its methods, which is the treatment an
 * object literal gets. That is what lets a method read off an instance
 * resolve to the method the class declares.
 */
function emitClassFacts(emitter: Emitter, cls: PyNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const body = field(cls, "body");
  for (const statement of body === null ? [] : children(body)) {
    const member = declaredBy(statement);
    if (member.type === "assignment") {
      const left = field(member, "left");
      const right = field(member, "right");
      if (left !== null && right !== null && left.type === "identifier") {
        add(
          emitter,
          "holdsProperty",
          classKey,
          left.text,
          valueKey(emitter, right),
        );
      }
      continue;
    }
    if (!FUNCTION_TYPES.has(member.type)) {
      continue;
    }
    const funcKey = emitFunctionFacts(emitter, member, true);
    const name = field(member, "name");
    if (name !== null) {
      add(emitter, "holdsProperty", classKey, name.text, funcKey);
    }
  }

  return classKey;
}

/**
 * Walk a module and emit the value facts. A nested function is walked in its
 * own right, so a body's returns and calls belong to the function that wrote
 * them.
 */
export function emitValueFacts(
  db: Database,
  filePath: string,
  root: PyNode,
): void {
  const emitter: Emitter = { db, filePath, enclosing: null };

  const declaresName = (child: PyNode, key: string): void => {
    const name = field(child, "name");
    if (name === null) {
      return;
    }
    add(emitter, "binds", nameId(filePath, name.text), key);
    // A module-level declaration is what another file gets when it imports the name.
    add(emitter, "exportsAs", filePath, name.text, key);
  };

  const walk = (node: PyNode): void => {
    for (const child of children(node)) {
      if (child.type === "class_definition") {
        declaresName(child, emitClassFacts(emitter, child));
        // Its methods are its own; descending would make them the module's.
        continue;
      }
      if (FUNCTION_TYPES.has(child.type)) {
        declaresName(child, emitFunctionFacts(emitter, child));
      }
      if (child.type === "assignment") {
        emitAssignment(emitter, child);
      }
      walk(child);
    }
  };

  walk(root);
  emitExpressionFacts(emitter, root);
}

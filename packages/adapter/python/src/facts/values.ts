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

/**
 * The key a read of this expression joins on, for a caller that has an
 * expression in hand and wants to ask the rules about it. `enclosing` is
 * the function the expression is written in, or null at module level.
 */
export function readKey(
  filePath: string,
  node: PyNode,
  enclosing: PyNode | null,
): string {
  if (node.type !== "identifier") {
    return nodeId(filePath, node);
  }
  if (enclosing !== null && parameterNames(enclosing).has(node.text)) {
    return `${nodeId(filePath, enclosing)}#${node.text}`;
  }
  return nameId(filePath, node.text);
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

/** What a function calls its parameters. What follows a `*` is left out, since it can only be passed by keyword. */
function parameterNames(fn: PyNode): Set<string> {
  const params = field(fn, "parameters");
  const declared = new Set<string>();
  for (const param of params === null ? [] : children(params)) {
    if (SPLAT_TYPES.has(param.type)) {
      continue;
    }
    const name = parameterName(param);
    if (name !== null) {
      declared.add(name.text);
    }
  }
  return declared;
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

/** The class a method belongs to, and what that method calls its receiver. */
interface MethodReceiver {
  classKey: string;
  name: string;
}

/**
 * A function's parameters by position, its returns, and the calls its body
 * makes. Where its name goes is the caller's to say, because a method belongs
 * to its class and a def belongs to its module.
 */
function emitFunctionFacts(
  emitter: Emitter,
  fn: PyNode,
  classKey?: string,
): string {
  const funcKey = nodeId(emitter.filePath, fn);
  add(emitter, "func", funcKey);

  const params = field(fn, "parameters");
  const declared = parameterNames(fn);
  // A method's first parameter is the receiver, which the caller does not
  // write, so counting it would put the first written argument in it.
  let position = classKey === undefined ? 0 : -1;
  let byPosition = true;
  let receiver: MethodReceiver | null = null;
  for (const param of params === null ? [] : children(params)) {
    if (SPLAT_TYPES.has(param.type)) {
      // What follows a `*` can only be passed by name.
      byPosition = false;
      continue;
    }
    const paramName = parameterName(param);
    if (paramName !== null) {
      const paramKey = `${funcKey}#${paramName.text}`;
      if (byPosition && position >= 0) {
        add(emitter, "paramOf", funcKey, String(position), paramKey);
      }
      // Calling a class makes one of it, so an instance is the class
      // object, and that is what a method's receiver comes down to.
      if (classKey !== undefined && position === -1) {
        receiver = { classKey, name: paramName.text };
        add(emitter, "binds", paramKey, classKey);
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
    if (child.type === "assignment") {
      emitBinding(inside, child, receiver);
    }
    emitExpressionFact(inside, child);
  });

  return funcKey;
}

/**
 * `name = value` at any level, which is what a chain follows one hop of,
 * and `self.name = value` inside a method, which puts the value on the
 * class so a later `self.name` finds it.
 */
function emitBinding(
  emitter: Emitter,
  assignment: PyNode,
  receiver: MethodReceiver | null,
): void {
  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (left === null || right === null) {
    return;
  }
  if (left.type === "identifier") {
    add(
      emitter,
      "binds",
      nameId(emitter.filePath, left.text),
      valueKey(emitter, right),
    );
    return;
  }
  if (receiver === null || left.type !== "attribute") {
    return;
  }

  const object = field(left, "object");
  const property = field(left, "attribute");
  if (
    object?.type !== "identifier" ||
    object.text !== receiver.name ||
    property === null
  ) {
    return;
  }
  add(
    emitter,
    "holdsProperty",
    receiver.classKey,
    property.text,
    valueKey(emitter, right),
  );
}

/** A module-level or function-level `name = value`, which another file gets by importing the name. */
function emitAssignment(emitter: Emitter, assignment: PyNode): void {
  emitBinding(emitter, assignment, null);

  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (left === null || right === null || left.type !== "identifier") {
    return;
  }
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
 * What a class body declares under a name: a method, or a class declared
 * inside another class. Null for anything else, which the class puts no
 * property under.
 */
function declaredMemberKey(
  emitter: Emitter,
  member: PyNode,
  classKey: string,
): string | null {
  if (member.type === "class_definition") {
    return emitClassFacts(emitter, member);
  }
  if (FUNCTION_TYPES.has(member.type)) {
    return emitFunctionFacts(emitter, member, classKey);
  }
  return null;
}

/**
 * A class is an object containing its methods, which is the treatment an
 * object literal gets. That is what lets a method read off an instance
 * resolve to the method the class declares.
 */
function emitClassFacts(emitter: Emitter, cls: PyNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const bases = field(cls, "superclasses");
  for (const base of bases === null ? [] : children(bases)) {
    add(emitter, "extends", classKey, valueKey(emitter, base));
  }

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
    const memberKey = declaredMemberKey(emitter, member, classKey);
    const name = field(member, "name");
    if (memberKey !== null && name !== null) {
      add(emitter, "holdsProperty", classKey, name.text, memberKey);
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

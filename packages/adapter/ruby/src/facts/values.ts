// values.ts: the facts @suss/resolution already joins, emitted for Ruby.
// The relation names and shapes come from that package's own header, and the
// README says which Ruby constructs differ from the other adapters.

import { field } from "../ast.js";

import type { Database } from "@suss/datalog";
import type { RbNode } from "../parser.js";

/**
 * A node's identity across the whole run. The end is part of it because a
 * call and its receiver start at the same offset.
 */
export function nodeId(filePath: string, node: RbNode): string {
  return `${filePath}:${node.startIndex}-${node.endIndex}`;
}

/** A name in a file, which is what a binding joins on. */
function nameId(filePath: string, name: string): string {
  return `${filePath}#${name}`;
}

/** A body written in one of these belongs to the thing it declares. */
const DECLARATION_TYPES = new Set([
  "method",
  "singleton_method",
  "lambda",
  "class",
  "module",
  "singleton_class",
]);

const WRITTEN_VALUE_TYPES = new Set([
  "string",
  "integer",
  "float",
  "true",
  "false",
  "nil",
  "simple_symbol",
  "hash_key_symbol",
]);

/** tree-sitter types a named child as nullable; dropping them once keeps every walk below flat. */
function children(node: RbNode): RbNode[] {
  return node.namedChildren.filter((child): child is RbNode => child !== null);
}

interface Emitter {
  db: Database;
  filePath: string;
  /**
   * The method whose body is being walked, and the parameters it declares.
   * A parameter is keyed under its own method, because two methods in one
   * file can both declare a `loader` and they are not the same value.
   */
  enclosing: { funcKey: string; params: ReadonlySet<string> } | null;
}

function add(emitter: Emitter, relation: string, ...tuple: string[]): void {
  emitter.db.add(relation, tuple);
}

/**
 * The key a value joins on. A bare name joins on the name, so a read of `x`
 * meets whatever `x` was bound to; anything else joins on its own node.
 */
function valueKey(emitter: Emitter, value: RbNode): string {
  if (value.type !== "identifier" && value.type !== "constant") {
    return nodeId(emitter.filePath, value);
  }
  const enclosing = emitter.enclosing;
  if (enclosing !== null && enclosing.params.has(value.text)) {
    return `${enclosing.funcKey}#${value.text}`;
  }
  return nameId(emitter.filePath, value.text);
}

/** A pair's key when it is written as a symbol or a string, which is what a property joins on. */
function pairKeyText(key: RbNode): string | null {
  if (key.type === "hash_key_symbol") {
    return key.text;
  }
  if (key.type === "simple_symbol") {
    return key.text.slice(1);
  }
  if (key.type === "string") {
    return key.text.slice(1, -1);
  }
  return null;
}

/** `config.host` parses as a call with a receiver and no arguments, which is Ruby's property read. */
function isPropertyRead(node: RbNode): boolean {
  return (
    node.type === "call" &&
    field(node, "receiver") !== null &&
    field(node, "arguments") === null &&
    children(node).every(
      (child) => child.type !== "do_block" && child.type !== "block",
    )
  );
}

function emitPropertyRead(emitter: Emitter, node: RbNode): void {
  const receiver = field(node, "receiver");
  const method = field(node, "method");
  if (receiver === null || method === null) {
    return;
  }

  add(
    emitter,
    "readsProperty",
    nodeId(emitter.filePath, node),
    valueKey(emitter, receiver),
    method.text,
  );
}

function emitCall(emitter: Emitter, call: RbNode): void {
  // A call is written out in the source, so a name bound to one ends its
  // chain there and `isWrittenAs` reads it back.
  add(emitter, "writtenValue", nodeId(emitter.filePath, call));

  const method = field(call, "method");
  if (method === null) {
    return;
  }

  // Ruby gives `receiver.method` no node of its own, so the method name is
  // where the read is keyed. Keying on the bare name would find a method of
  // that name at the top of the file instead.
  const receiver = field(call, "receiver");
  const callKey = nodeId(emitter.filePath, call);
  const calleeKey =
    receiver === null
      ? valueKey(emitter, method)
      : nodeId(emitter.filePath, method);
  add(emitter, "call", callKey, calleeKey);
  if (receiver !== null) {
    add(
      emitter,
      "readsProperty",
      calleeKey,
      valueKey(emitter, receiver),
      method.text,
    );
  }

  const args = field(call, "arguments");
  let position = 0;
  for (const argument of args === null ? [] : children(args)) {
    if (argument.type === "pair") {
      const key = field(argument, "key");
      const value = field(argument, "value");
      const keyText = key === null ? null : pairKeyText(key);
      if (keyText !== null && value !== null) {
        add(
          emitter,
          "callKeywordArg",
          callKey,
          keyText,
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

/** An array records its elements under their positions, the way the other adapters do. */
function emitArray(emitter: Emitter, array: RbNode): void {
  const objectKey = nodeId(emitter.filePath, array);
  add(emitter, "objectValue", objectKey);
  let position = 0;
  for (const element of children(array)) {
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

/** A hash records its values under their written keys. */
function emitHash(emitter: Emitter, hash: RbNode): void {
  const objectKey = nodeId(emitter.filePath, hash);
  add(emitter, "objectValue", objectKey);
  for (const pair of children(hash)) {
    if (pair.type !== "pair") {
      continue;
    }
    const key = field(pair, "key");
    const value = field(pair, "value");
    const keyText = key === null ? null : pairKeyText(key);
    if (keyText === null || value === null) {
      continue;
    }
    add(emitter, "holdsProperty", objectKey, keyText, valueKey(emitter, value));
  }
}

/** Every expression under a node, without crossing into a nested declaration. */
function walkExpressions(node: RbNode, visit: (child: RbNode) => void): void {
  for (const child of children(node)) {
    if (DECLARATION_TYPES.has(child.type)) {
      continue;
    }
    visit(child);
    walkExpressions(child, visit);
  }
}

function emitExpressionFacts(emitter: Emitter, node: RbNode): void {
  walkExpressions(node, (child) => {
    if (isPropertyRead(child)) {
      emitPropertyRead(emitter, child);
    } else if (child.type === "call") {
      emitCall(emitter, child);
    }
    if (child.type === "array") {
      emitArray(emitter, child);
    }
    if (child.type === "hash") {
      emitHash(emitter, child);
    }
    if (WRITTEN_VALUE_TYPES.has(child.type)) {
      add(emitter, "writtenValue", nodeId(emitter.filePath, child));
    }
  });
}

/** A method returns its last expression when it writes no return, which Python has no equivalent of. */
function implicitReturn(body: RbNode): RbNode | null {
  const statements = children(body).filter(
    (child) => child.type !== "rescue" && child.type !== "ensure",
  );
  const last = statements[statements.length - 1];
  return last === undefined || last.type === "return" ? null : last;
}

/**
 * Where a method's name goes is the caller's to say, because a method inside a
 * class belongs to that class and one at the top of a file belongs to the file.
 */
function emitMethodFacts(emitter: Emitter, method: RbNode): string {
  const funcKey = nodeId(emitter.filePath, method);
  add(emitter, "func", funcKey);

  const params = field(method, "parameters");
  const declared = new Set<string>();
  let position = 0;
  for (const param of params === null ? [] : children(params)) {
    const paramName =
      param.type === "identifier" ? param : (field(param, "name") ?? null);
    if (paramName !== null) {
      declared.add(paramName.text);
      add(
        emitter,
        "paramOf",
        funcKey,
        String(position),
        `${funcKey}#${paramName.text}`,
      );
    }
    position += 1;
  }

  const inside: Emitter = {
    ...emitter,
    enclosing: { funcKey, params: declared },
  };

  const body = field(method, "body");
  if (body === null) {
    return funcKey;
  }

  const recordNested = (node: RbNode): void => {
    for (const child of children(node)) {
      if (DECLARATION_TYPES.has(child.type)) {
        add(emitter, "containsFn", funcKey, nodeId(emitter.filePath, child));
        continue;
      }
      recordNested(child);
    }
  };
  recordNested(body);

  walkExpressions(body, (child) => {
    if (child.type === "return") {
      // `return x` wraps the value in an argument list, the same shape a
      // call's arguments take.
      const first = children(child)[0];
      const returned =
        first?.type === "argument_list" ? children(first)[0] : first;
      if (returned !== undefined) {
        add(inside, "returnsValue", funcKey, valueKey(inside, returned));
      }
    }
    if (child.type === "call") {
      add(inside, "bodyCalls", funcKey, nodeId(inside.filePath, child));
    }
  });

  const implicit = implicitReturn(body);
  if (implicit !== null) {
    add(inside, "returnsValue", funcKey, valueKey(inside, implicit));
  }

  emitExpressionFacts(inside, body);

  return funcKey;
}

function emitAssignment(emitter: Emitter, assignment: RbNode): void {
  const left = field(assignment, "left");
  const right = field(assignment, "right");
  if (right === null) {
    return;
  }
  if (left?.type !== "identifier" && left?.type !== "constant") {
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

const METHOD_TYPES = new Set(["method", "singleton_method"]);

/**
 * A class is an object containing its methods, which is the treatment an
 * array and a hash already get. That is what lets a method read off an
 * instance resolve to the method the class declares.
 */
function emitClassFacts(emitter: Emitter, cls: RbNode): string {
  const classKey = nodeId(emitter.filePath, cls);
  add(emitter, "objectValue", classKey);

  const body = field(cls, "body");
  for (const statement of body === null ? [] : children(body)) {
    if (statement.type === "assignment") {
      const left = field(statement, "left");
      const right = field(statement, "right");
      if (left !== null && right !== null && left.type === "constant") {
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
    if (!METHOD_TYPES.has(statement.type)) {
      continue;
    }
    const funcKey = emitMethodFacts(emitter, statement);
    const name = field(statement, "name");
    if (name !== null) {
      add(emitter, "holdsProperty", classKey, name.text, funcKey);
    }
  }

  return classKey;
}

/**
 * Walk a file and emit the value facts. A method is walked in its own right,
 * so a body's returns and calls belong to the method that wrote them.
 */
export function emitValueFacts(
  db: Database,
  filePath: string,
  root: RbNode,
): void {
  const emitter: Emitter = { db, filePath, enclosing: null };

  const declaresName = (child: RbNode, key: string): void => {
    const name = field(child, "name");
    if (name === null) {
      return;
    }
    add(emitter, "binds", nameId(filePath, name.text), key);
    // A declaration at the top of a file is what another file gets by name.
    add(emitter, "exportsAs", filePath, name.text, key);
  };

  const walk = (node: RbNode): void => {
    for (const child of children(node)) {
      if (child.type === "class") {
        declaresName(child, emitClassFacts(emitter, child));
        // Its methods are its own; descending would make them the file's.
        continue;
      }
      if (METHOD_TYPES.has(child.type)) {
        declaresName(child, emitMethodFacts(emitter, child));
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

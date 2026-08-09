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
}

function add(emitter: Emitter, relation: string, ...tuple: string[]): void {
  emitter.db.add(relation, tuple);
}

/**
 * The key a value joins on. A bare name joins on the name, so a read of `x`
 * meets whatever `x` was bound to; anything else joins on its own node.
 */
function valueKey(emitter: Emitter, value: RbNode): string {
  if (value.type === "identifier" || value.type === "constant") {
    return nameId(emitter.filePath, value.text);
  }
  return nodeId(emitter.filePath, value);
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
  const method = field(call, "method");
  if (method === null) {
    return;
  }

  const callKey = nodeId(emitter.filePath, call);
  add(emitter, "call", callKey, valueKey(emitter, method));

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

function emitMethodFacts(emitter: Emitter, method: RbNode): void {
  const funcKey = nodeId(emitter.filePath, method);
  add(emitter, "func", funcKey);

  const name = field(method, "name");
  if (name !== null) {
    add(emitter, "binds", nameId(emitter.filePath, name.text), funcKey);
  }

  const params = field(method, "parameters");
  let position = 0;
  for (const param of params === null ? [] : children(params)) {
    const paramName =
      param.type === "identifier" ? param : (field(param, "name") ?? null);
    if (paramName !== null) {
      add(
        emitter,
        "paramOf",
        funcKey,
        String(position),
        nameId(emitter.filePath, paramName.text),
      );
    }
    position += 1;
  }

  const body = field(method, "body");
  if (body === null) {
    return;
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
        add(emitter, "returnsValue", funcKey, valueKey(emitter, returned));
      }
    }
    if (child.type === "call") {
      add(emitter, "bodyCalls", funcKey, nodeId(emitter.filePath, child));
    }
  });

  const implicit = implicitReturn(body);
  if (implicit !== null) {
    add(emitter, "returnsValue", funcKey, valueKey(emitter, implicit));
  }

  emitExpressionFacts(emitter, body);
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
  const emitter: Emitter = { db, filePath };

  const walk = (node: RbNode): void => {
    for (const child of children(node)) {
      if (child.type === "method" || child.type === "singleton_method") {
        emitMethodFacts(emitter, child);
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
